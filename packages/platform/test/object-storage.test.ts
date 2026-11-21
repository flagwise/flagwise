// The storage drivers. The S3 driver is tested as our code only: what it sends to the client and
// what it makes of the answers, with a fake client in place of the store.
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { fileStorage, memoryStorage, s3ClientConfig, s3Storage, type ObjectStorage, type S3Sender } from '../src/index.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b))

function behavesLikeStorage(name: string, storage: () => ObjectStorage) {
  describe(name, () => {
    it('reads back what it wrote, and null for a missing key', async () => {
      const s = storage()
      await s.put('apps/app_a/rpt_1', bytes('{"jane":"doe"}'), 'application/json')
      expect(text(await s.get('apps/app_a/rpt_1'))).toBe('{"jane":"doe"}')
      expect(await s.get('apps/app_a/rpt_missing')).toBeNull()
    })

    it('replaces an object with the same key, and deletes idempotently', async () => {
      const s = storage()
      await s.put('apps/app_a/rpt_2', bytes('one'), 'text/plain')
      await s.put('apps/app_a/rpt_2', bytes('two'), 'text/plain')
      expect(text(await s.get('apps/app_a/rpt_2'))).toBe('two')
      await s.delete('apps/app_a/rpt_2')
      await s.delete('apps/app_a/rpt_2')
      expect(await s.get('apps/app_a/rpt_2')).toBeNull()
    })

    it('refuses keys that could escape their prefix', async () => {
      const s = storage()
      for (const key of ['', 'apps//rpt_1', 'apps/../secret', 'apps/./x', '/apps/x', 'apps/x y', 'a'.repeat(1025)]) {
        await expect(s.put(key, bytes('x'), 'text/plain')).rejects.toThrow(RangeError)
        await expect(s.get(key)).rejects.toThrow(RangeError)
      }
    })
  })
}

behavesLikeStorage('memory storage', () => memoryStorage())
behavesLikeStorage('file storage', () => fileStorage({ dir: mkdtempSync(join(tmpdir(), 'storage-')) }))

it('file storage keeps objects as owner-only files under its directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-'))
  await fileStorage({ dir }).put('apps/app_a/rpt_1', new TextEncoder().encode('{}'), 'application/json')
  expect(readFileSync(join(dir, 'apps', 'app_a', 'rpt_1'), 'utf8')).toBe('{}')
  expect(statSync(join(dir, 'apps', 'app_a', 'rpt_1')).mode & 0o777).toBe(0o600)
  expect(readdirSync(join(dir, 'apps', 'app_a'))).toEqual(['rpt_1'])
})

it('memory storage keeps its own copy of the bytes', async () => {
  const s = memoryStorage()
  const body = bytes('jane')
  await s.put('k', body, 'text/plain')
  body[0] = 0
  const read = await s.get('k')
  read![1] = 0
  expect(text(await s.get('k'))).toBe('jane')
  expect(s.keys()).toEqual(['k'])
})

/** An error as the SDK throws it for a store's answer. */
const s3Failure = (name: string, status: number) => Object.assign(new Error(`${name} from the store`), { name, $metadata: { httpStatusCode: status } })

/** A fake client: keeps objects by key, records each command, and fails where told to. */
function fakeClient(failWith: (command: object) => Error | undefined = () => undefined) {
  const objects = new Map<string, Uint8Array>()
  const sent: { command: string; input: Record<string, unknown> }[] = []
  const client: S3Sender = {
    async send(command) {
      const { input } = command as { input: Record<string, unknown> }
      sent.push({ command: command.constructor.name, input })
      const error = failWith(command)
      if (error) throw error
      if (command instanceof PutObjectCommand) objects.set(String(input['Key']), input['Body'] as Uint8Array)
      if (command instanceof DeleteObjectCommand) objects.delete(String(input['Key']))
      if (command instanceof GetObjectCommand) {
        const body = objects.get(String(input['Key']))
        if (!body) throw s3Failure('NoSuchKey', 404)
        return { Body: { transformToByteArray: async () => body } }
      }
      return {}
    },
  }
  return { client, sent }
}

const OPTIONS = { endpoint: 'http://storage.test', bucket: 'fw-evidence', accessKeyId: 'jane-key', secretAccessKey: 'jane-secret' }

behavesLikeStorage('S3 storage', () => s3Storage(OPTIONS, fakeClient().client))

describe('S3 storage', () => {
  it('sends each object to its bucket and key, with its content type', async () => {
    const { client, sent } = fakeClient()
    const s = s3Storage(OPTIONS, client)
    await s.put('apps/app_a/rpt_1', bytes('{}'), 'application/json')
    await s.get('apps/app_a/rpt_1')
    await s.delete('apps/app_a/rpt_1')
    await s.ensureBucket()
    expect(sent).toEqual([
      { command: PutObjectCommand.name, input: { Bucket: 'fw-evidence', Key: 'apps/app_a/rpt_1', Body: bytes('{}'), ContentType: 'application/json' } },
      { command: GetObjectCommand.name, input: { Bucket: 'fw-evidence', Key: 'apps/app_a/rpt_1' } },
      { command: DeleteObjectCommand.name, input: { Bucket: 'fw-evidence', Key: 'apps/app_a/rpt_1' } },
      { command: CreateBucketCommand.name, input: { Bucket: 'fw-evidence' } },
    ])
  })

  it('treats a missing object as gone, and a bucket it already owns as made', async () => {
    const s = s3Storage(OPTIONS, fakeClient((c) => (c instanceof DeleteObjectCommand ? s3Failure('NoSuchKey', 404) : c instanceof CreateBucketCommand ? s3Failure('BucketAlreadyOwnedByYou', 409) : undefined)).client)
    await expect(s.delete('apps/app_a/rpt_1')).resolves.toBeUndefined()
    await expect(s.ensureBucket()).resolves.toBeUndefined()
  })

  it('reports a failure with the operation, status and code, never the credentials', async () => {
    const s = s3Storage(OPTIONS, fakeClient(() => s3Failure('SignatureDoesNotMatch', 403)).client)
    for (const call of [() => s.put('apps/app_a/rpt_1', bytes('x'), 'text/plain'), () => s.get('apps/app_a/rpt_1'), () => s.delete('apps/app_a/rpt_1')]) {
      const err = await call().catch((e: Error) => e)
      expect((err as Error).message).toMatch(/^Object storage (put|get|delete) apps\/app_a\/rpt_1 failed: 403 SignatureDoesNotMatch$/)
      expect((err as Error).message).not.toMatch(/jane-(key|secret)/)
    }
    const owned = s3Storage(OPTIONS, fakeClient(() => s3Failure('BucketAlreadyExists', 409)).client)
    await expect(owned.ensureBucket()).rejects.toThrow('Object storage create bucket fw-evidence failed: 409 BucketAlreadyExists')
    const down = s3Storage(OPTIONS, fakeClient(() => new Error('connect ECONNREFUSED')).client)
    await expect(down.get('apps/app_a/rpt_1')).rejects.toThrow('Object storage get apps/app_a/rpt_1 failed: no response Error')
  })

  it('refuses a bucket name the store would refuse', () => {
    expect(() => s3Storage({ ...OPTIONS, bucket: 'Jane_Doe' }, fakeClient().client)).toThrow(RangeError)
  })

  it('addresses the store by path, and sends checksums only where required', () => {
    expect(s3ClientConfig({ ...OPTIONS, region: 'eu-west-1' })).toEqual({
      endpoint: 'http://storage.test',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'jane-key', secretAccessKey: 'jane-secret' },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    expect(s3ClientConfig(OPTIONS).region).toBe('us-east-1')
  })
})
