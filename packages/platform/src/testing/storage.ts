// Object storage for tests: local files in a fresh temp folder by default, or a real S3-compatible
// store when TEST_S3_URL names one, so the tests that store evidence can run end to end on it.
// TEST_S3_URL is `http(s)://<access key>:<secret>@<host>/<bucket>` with an existing bucket; tests
// only read, write and delete in it, and leave what the server wrote (a test bucket with an expiry
// rule keeps it clean). Keys never collide: every test makes its own apps and reports.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStorage, s3Storage, type ObjectStorage, type S3StorageOptions } from '../storage/object-storage.ts'

export const testS3Url: string | undefined = process.env.TEST_S3_URL || undefined

/** The S3 store TEST_S3_URL names, or undefined when it is not set. */
function testS3Options(url = testS3Url): S3StorageOptions | undefined {
  if (!url) return undefined
  const u = new URL(url)
  const bucket = u.pathname.replace(/^\/+|\/+$/g, '')
  if (!bucket || bucket.includes('/')) throw new Error('TEST_S3_URL needs the bucket as its path: http(s)://<access key>:<secret>@<host>/<bucket>')
  return { endpoint: u.origin, bucket, accessKeyId: decodeURIComponent(u.username), secretAccessKey: decodeURIComponent(u.password) }
}

/** Storage for a test: the TEST_S3_URL store, else files in a new temp folder. */
export function testStorage(): ObjectStorage {
  const s3 = testS3Options()
  return s3 ? s3Storage(s3) : fileStorage({ dir: mkdtempSync(join(tmpdir(), 'flagwise-evidence-')) })
}

/** The same choice as server settings (STORAGE_DRIVER and the rest), for a server a test starts. */
export function testStorageEnv(): Record<string, string> {
  const s3 = testS3Options()
  return s3
    ? { STORAGE_DRIVER: 's3', S3_ENDPOINT: s3.endpoint, S3_BUCKET: s3.bucket, S3_ACCESS_KEY_ID: s3.accessKeyId, S3_SECRET_ACCESS_KEY: s3.secretAccessKey }
    : { STORAGE_DIR: mkdtempSync(join(tmpdir(), 'flagwise-evidence-')) }
}
