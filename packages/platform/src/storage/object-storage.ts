// Object storage for evidence snapshots: a memory driver for tests, a file driver (files under a
// directory, for a single-node self-host) and an S3 driver for any S3-compatible store (MinIO
// locally, S3 or R2 in production).

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AwsClient } from 'aws4fetch'

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

/**
 * Talks to an S3-compatible store with path-style URLs (`{endpoint}/{bucket}/{key}`) and SigV4
 * signed requests. A response other than the expected ones throws an Error with the status and
 * the store's error code, never the credentials.
 */
export function s3Storage(opts: S3StorageOptions): S3Storage {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(opts.bucket)) throw new RangeError(`Not a valid bucket name: ${JSON.stringify(opts.bucket)}`)
  const client = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    service: 's3',
    region: opts.region ?? 'us-east-1',
  })
  const base = `${opts.endpoint.replace(/\/+$/, '')}/${opts.bucket}`
  const urlOf = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`

  const fail = async (what: string, res: Response): Promise<never> => {
    const code = /<Code>([^<]*)<\/Code>/.exec(await res.text())?.[1]
    throw new Error(`Object storage ${what} failed: ${res.status}${code ? ` ${code}` : ''}`)
  }

  return {
    async put(key, body, contentType) {
      checkKey(key)
      const res = await client.fetch(urlOf(key), { method: 'PUT', body, headers: { 'content-type': contentType } })
      if (!res.ok) await fail(`put ${key}`, res)
      await res.body?.cancel()
    },
    async get(key) {
      checkKey(key)
      const res = await client.fetch(urlOf(key))
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      if (!res.ok) await fail(`get ${key}`, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(key) {
      checkKey(key)
      const res = await client.fetch(urlOf(key), { method: 'DELETE' })
      if (!res.ok && res.status !== 404) await fail(`delete ${key}`, res)
      await res.body?.cancel()
    },
    async ensureBucket() {
      const res = await client.fetch(base, { method: 'PUT' })
      if (res.ok) return void (await res.body?.cancel())
      const text = await res.text()
      if (res.status === 409 && text.includes('BucketAlreadyOwnedByYou')) return
      throw new Error(`Object storage create bucket ${opts.bucket} failed: ${res.status}`)
    },
  }
}
