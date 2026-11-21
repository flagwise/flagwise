// Object storage for evidence snapshots: a memory driver for tests, a file driver (files under a
// directory, for a single-node self-host) and an S3 driver for any S3-compatible store (MinIO
// locally, S3 or R2 in production).

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'

export interface ObjectStorage {
  /** Writes the object, replacing any object with the same key. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  /** The object's bytes, or null when there is no object with this key. */
  get(key: string): Promise<Uint8Array | null>
  /** Deletes the object; deleting a missing key is not an error. */
  delete(key: string): Promise<void>
}

/** Keys are `/`-separated segments of `A-Z a-z 0-9 _ . -`, none empty, `.` or `..`; at most 1024 characters. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/

function checkKey(key: string): void {
  const segments = key.split('/')
  if (key.length > 1024 || !segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) {
    throw new RangeError(`Not a valid object key: ${JSON.stringify(key)}`)
  }
}

/** Keeps objects in memory. Each put and get copies the bytes, so callers cannot change stored objects. */
export function memoryStorage(): ObjectStorage & { keys(): string[] } {
  const objects = new Map<string, Uint8Array>()
  return {
    async put(key, body) {
      checkKey(key)
      objects.set(key, body.slice())
    },
    async get(key) {
      checkKey(key)
      return objects.get(key)?.slice() ?? null
    },
    async delete(key) {
      checkKey(key)
      objects.delete(key)
    },
    keys: () => [...objects.keys()].sort(),
  }
}

/**
 * Keeps each object as a file at `{dir}/{key}`; the content type is not kept. A put writes a
 * temporary file and renames it over the object, so a reader sees the old or the new bytes, never
 * part of them. Files are created readable by the owner only.
 */
export function fileStorage(opts: { readonly dir: string }): ObjectStorage {
  const pathOf = (key: string) => {
    checkKey(key)
    return join(opts.dir, ...key.split('/'))
  }
  return {
    async put(key, body) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(tmp, body, { mode: 0o600 })
        await rename(tmp, path)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathOf(key)))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
  }
}

export interface S3StorageOptions {
  /** The store's base URL, e.g. `http://minio:9000`; objects are addressed by path. */
  readonly endpoint: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** Default 'us-east-1', which MinIO accepts. */
  readonly region?: string
}

export interface S3Storage extends ObjectStorage {
  /** Creates the bucket when it does not exist yet. */
  ensureBucket(): Promise<void>
}

/** What the driver needs of an S3 client: sending a command. Tests pass their own. */
export interface S3Sender {
  send(command: object): Promise<unknown>
}

/**
 * The client config for an S3-compatible store: path-style URLs (`{endpoint}/{bucket}/{key}`),
 * which MinIO and most self-hosted stores need, and checksums only where an operation requires
 * them, since some S3-compatible stores refuse the ones the SDK adds by default.
 */
export function s3ClientConfig(opts: S3StorageOptions): S3ClientConfig {
  return {
    endpoint: opts.endpoint,
    region: opts.region ?? 'us-east-1',
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }
}

/** An S3 error's code and HTTP status, as the SDK reports them. */
function s3Error(err: unknown): { name: string; status: number | undefined } {
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } } | null
  return { name: typeof e?.name === 'string' ? e.name : 'Error', status: e?.$metadata?.httpStatusCode }
}

/**
 * Talks to an S3-compatible store through the official client (`client` replaces it in tests). A
 * failure throws an Error with the operation, the status and the store's error code, never the
 * credentials.
 */
export function s3Storage(opts: S3StorageOptions, client: S3Sender = new S3Client(s3ClientConfig(opts))): S3Storage {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(opts.bucket)) throw new RangeError(`Not a valid bucket name: ${JSON.stringify(opts.bucket)}`)
  const Bucket = opts.bucket
  const fail = (what: string, err: unknown): never => {
    const { name, status } = s3Error(err)
    throw new Error(`Object storage ${what} failed: ${status ?? 'no response'} ${name}`)
  }

  return {
    async put(key, body, contentType) {
      checkKey(key)
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType })).catch((err) => fail(`put ${key}`, err))
    },
    async get(key) {
      checkKey(key)
      try {
        const res = (await client.send(new GetObjectCommand({ Bucket, Key: key }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } }
        return res.Body ? await res.Body.transformToByteArray() : new Uint8Array()
      } catch (err) {
        const { name, status } = s3Error(err)
        if (name === 'NoSuchKey' || status === 404) return null
        return fail(`get ${key}`, err)
      }
    },
    async delete(key) {
      checkKey(key)
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
      } catch (err) {
        if (s3Error(err).status !== 404) fail(`delete ${key}`, err)
      }
    },
    async ensureBucket() {
      try {
        await client.send(new CreateBucketCommand({ Bucket }))
      } catch (err) {
        if (s3Error(err).name !== 'BucketAlreadyOwnedByYou') fail(`create bucket ${Bucket}`, err)
      }
    },
  }
}
