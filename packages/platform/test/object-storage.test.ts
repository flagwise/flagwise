// The memory and file drivers always run; the S3 driver runs against TEST_S3_URL (MinIO locally) and skips without it.
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileStorage, memoryStorage, s3Storage, type ObjectStorage } from '../src/index.ts'
import { createTestBucket, testS3Url, type TestBucket } from '../src/testing/index.ts'

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

describe.skipIf(!testS3Url)('S3 storage on a real store', () => {
  let bucket: TestBucket
  beforeAll(async () => {
    bucket = await createTestBucket()
  })
  afterAll(async () => {
    await bucket?.drop()
  })

  behavesLikeStorage('s3 storage', () => bucket.storage)

  it('creating an existing bucket is fine', async () => {
    await expect(bucket.storage.ensureBucket()).resolves.toBeUndefined()
  })

  it('reports a failure with its status and code, without the credentials', async () => {
    const wrong = s3Storage({ ...bucket.options, secretAccessKey: 'not-the-secret' })
    const err = await wrong.get('apps/app_a/rpt_1').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^Object storage get apps\/app_a\/rpt_1 failed: 403 SignatureDoesNotMatch$/)
    expect((err as Error).message).not.toContain('not-the-secret')
  })

  it('refuses a bucket name the store would refuse', () => {
    expect(() => s3Storage({ ...bucket.options, bucket: 'Jane_Doe' })).toThrow(RangeError)
  })
})
