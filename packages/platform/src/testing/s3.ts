// A throwaway bucket for tests. Needs TEST_S3_URL: `http://<access key>:<secret>@<host>`, an
// S3-compatible store whose user can create buckets (MinIO locally). Tests that need it skip
// when it is not set.

import { randomBytes } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import { s3Storage, type S3Storage, type S3StorageOptions } from '../storage/object-storage.ts'

export const testS3Url: string | undefined = process.env.TEST_S3_URL || undefined

export interface TestBucket {
  readonly options: S3StorageOptions
  /** Storage on the bucket that remembers what it wrote, so drop() can empty the bucket. */
  readonly storage: S3Storage
  /** Deletes every object written through `storage`, then the bucket. */
  drop(): Promise<void>
}

export async function createTestBucket(): Promise<TestBucket> {
  if (!testS3Url) throw new Error('TEST_S3_URL is not set')
  const url = new URL(testS3Url)
  const options: S3StorageOptions = {
    endpoint: url.origin,
    bucket: `fw-test-${randomBytes(5).toString('hex')}`,
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
  }
  const inner = s3Storage(options)
  await inner.ensureBucket()
  const written = new Set<string>()
  const storage: S3Storage = {
    ...inner,
    async put(key, body, contentType) {
      await inner.put(key, body, contentType)
      written.add(key)
    },
  }
  return {
    options,
    storage,
    async drop() {
      for (const key of written) await inner.delete(key)
      const client = new AwsClient({ accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, service: 's3', region: 'us-east-1' })
      const res = await client.fetch(`${options.endpoint}/${options.bucket}`, { method: 'DELETE' })
      await res.body?.cancel()
    },
  }
}
