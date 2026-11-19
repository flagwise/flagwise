import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newKeyringEntry } from '@flagwise/platform'
import { describe, expect, it } from 'vitest'
import { serverConfigFromEnv } from '../src/index.ts'

const DB = { DATABASE_APP_URL: 'postgres://fw_app:a@db/flagwise', DATABASE_SYSTEM_URL: 'postgres://fw_system:s@db/flagwise' }

describe('serverConfigFromEnv', () => {
  it('needs only the app and system database roles, with defaults for the rest', async () => {
    expect(await serverConfigFromEnv(DB)).toEqual({
      mode: 'all',
      port: 3000,
      database: { setup: 'roles', appUrl: DB.DATABASE_APP_URL, systemUrl: DB.DATABASE_SYSTEM_URL, poolMax: 10 },
      storage: { driver: 'local', dir: resolve(process.cwd(), '.data/storage') },
      rateLimit: { ratePerSecond: 10, burst: 50 },
      llm: { llm: undefined, redact: true },
      secrets: null,
      webhooksAllowHttp: false,
    })
  })

  it('reads the master keys from SECRETS_ENCRYPTION_KEY, or from the file it names, and names a bad one without its key', async () => {
    const key = newKeyringEntry('k2', () => new Uint8Array(32).fill(7))
    const old = newKeyringEntry('k1', () => new Uint8Array(32).fill(8))
    const fromValue = (await serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: `${key},${old}` })).secrets!
    expect(fromValue.current).toBe('k2')
    expect([...fromValue.keys.keys()]).toEqual(['k2', 'k1'])

    const dir = await mkdtemp(join(tmpdir(), 'flagwise-secrets-'))
    await writeFile(join(dir, 'the-secret-key'), `${key}\n`)
    await writeFile(join(dir, 'empty'), '\n')
    // Absolute, or relative to where the command was started (INIT_CWD).
    expect((await serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: join(dir, 'the-secret-key') })).secrets!.current).toBe('k2')
    expect((await serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: 'the-secret-key', INIT_CWD: dir })).secrets!.current).toBe('k2')
    expect((await serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: './the-secret-key', INIT_CWD: dir })).secrets!.current).toBe('k2')
    await expect(serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: 'missing', INIT_CWD: dir })).rejects.toThrow(`read as a file, and ${join(dir, 'missing')} cannot be read (ENOENT)`)
    await expect(serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: 'empty', INIT_CWD: dir })).rejects.toThrow('which is empty')

    const bad = await serverConfigFromEnv({ ...DB, SECRETS_ENCRYPTION_KEY: 'k1:c2hvcnQ=' }).catch((e: Error) => e.message)
    expect(bad).toContain('SECRETS_ENCRYPTION_KEY: Key 1 (k1)')
    expect(bad).toContain('./name')
    expect(bad).not.toContain('c2hvcnQ')
    await rm(dir, { recursive: true })
    expect((await serverConfigFromEnv({ ...DB, WEBHOOKS_ALLOW_HTTP: 'true' })).webhooksAllowHttp).toBe(true)
  })

  it('resolves a relative STORAGE_DIR from where the command was started', async () => {
    expect((await serverConfigFromEnv({ ...DB, INIT_CWD: '/srv/flagwise' })).storage).toEqual({ driver: 'local', dir: '/srv/flagwise/.data/storage' })
    expect((await serverConfigFromEnv({ ...DB, INIT_CWD: '/srv/flagwise', STORAGE_DIR: 'evidence' })).storage).toEqual({ driver: 'local', dir: '/srv/flagwise/evidence' })
  })

  it('takes DATABASE_URL when the role URLs are not set, and prefers the role URLs', async () => {
    const DATABASE_URL = 'postgres://flagwise:secret@db/flagwise'
    expect((await serverConfigFromEnv({ DATABASE_URL })).database).toEqual({ setup: 'single', url: DATABASE_URL, poolMax: 10 })
    expect((await serverConfigFromEnv({ ...DB, DATABASE_URL })).database).toMatchObject({ setup: 'roles', appUrl: DB.DATABASE_APP_URL })
  })

  it('reads every setting', async () => {
    const config = await serverConfigFromEnv({
      ...DB,
      MODE: 'worker',
      PORT: '8080',
      DATABASE_POOL_MAX: '4',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'evidence',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_REGION: 'eu-west-1',
      API_RATE_PER_SECOND: '50',
      API_RATE_BURST: '100',
      LLM_REDACTION: 'false',
    })
    expect(config).toMatchObject({
      mode: 'worker',
      port: 8080,
      database: { poolMax: 4 },
      storage: { driver: 's3', endpoint: 'http://minio:9000', bucket: 'evidence', accessKeyId: 'id', secretAccessKey: 'secret', region: 'eu-west-1' },
      rateLimit: { ratePerSecond: 50, burst: 100 },
      llm: { redact: false },
    })
    expect((await serverConfigFromEnv({ ...DB, STORAGE_DIR: '/data/evidence' })).storage).toEqual({ driver: 'local', dir: '/data/evidence' })
  })

  it('refuses missing and bad settings, naming them', async () => {
    await expect(serverConfigFromEnv({})).rejects.toThrow('Set DATABASE_URL, or DATABASE_APP_URL and DATABASE_SYSTEM_URL')
    // A missing role URL never falls back to the owner's DATABASE_URL.
    await expect(serverConfigFromEnv({ DATABASE_APP_URL: DB.DATABASE_APP_URL, DATABASE_URL: 'postgres://flagwise@db/flagwise' })).rejects.toThrow(
      'Set both DATABASE_APP_URL and DATABASE_SYSTEM_URL, or neither',
    )
    await expect(serverConfigFromEnv({ ...DB, MODE: 'both' })).rejects.toThrow('MODE must be api, worker, all (got "both")')
    await expect(serverConfigFromEnv({ ...DB, PORT: '80a' })).rejects.toThrow('PORT must be a whole number of at least 1 (got "80a")')
    await expect(serverConfigFromEnv({ ...DB, API_RATE_BURST: '0' })).rejects.toThrow('API_RATE_BURST must be a whole number of at least 1 (got "0")')
    await expect(serverConfigFromEnv({ ...DB, STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://minio:9000' })).rejects.toThrow('S3_BUCKET is required')
    await expect(serverConfigFromEnv({ ...DB, LLM_PROVIDER: 'anthropic' })).rejects.toThrow('LLM_API_KEY is required')
  })
})
