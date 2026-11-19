// The server's settings, read once at startup from an environment record the entrypoint passes in.
// The database is one URL (simple: the server also creates the roles and migrates) or the app and
// system role URLs (strict: the owner and admin roles stay with the CLI, so a compromised server
// cannot change the schema or read past row-level security).

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseKeyring, type BucketConfig, type Keyring } from '@flagwise/platform'
import { envReader, type Env } from './env.ts'
import { llmFromEnv, type LlmSettings } from './llm.ts'

export type Mode = 'api' | 'worker' | 'all'

export type StorageConfig =
  | { readonly driver: 'local'; readonly dir: string }
  | { readonly driver: 's3'; readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string; readonly region?: string }

export type DatabaseConfig =
  /** DATABASE_URL: its user owns the tables; the server's connections switch to the app and system roles. */
  | { readonly setup: 'single'; readonly url: string; readonly poolMax: number }
  /** DATABASE_APP_URL and DATABASE_SYSTEM_URL: the server logs in as each role. */
  | { readonly setup: 'roles'; readonly appUrl: string; readonly systemUrl: string; readonly poolMax: number }

export interface ServerConfig {
  readonly mode: Mode
  readonly port: number
  readonly database: DatabaseConfig
  readonly storage: StorageConfig
  /** Each app's token bucket for the public API. */
  readonly rateLimit: BucketConfig
  readonly llm: LlmSettings
  /** The master keys secrets at rest are sealed with; null when none is set, and then webhooks are off. */
  readonly secrets: Keyring | null
  /** Allow http: webhook endpoints, for local development. */
  readonly webhooksAllowHttp: boolean
}

/**
 * Reads:
 * - MODE: api, worker or all (default all). PORT (default 3000).
 * - The database: DATABASE_APP_URL and DATABASE_SYSTEM_URL together (the app and system roles),
 *   else DATABASE_URL (the user owning the tables). Only one of the two role URLs is an error, so a
 *   missing one never falls back to the owner. DATABASE_POOL_MAX per role (default 10).
 * - STORAGE_DRIVER: local (default; files under STORAGE_DIR, default .data/storage) or s3
 *   (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY required; S3_REGION optional).
 * - API_RATE_PER_SECOND (default 10) and API_RATE_BURST (default 50), per app.
 * - The LLM settings, through llmFromEnv.
 * - SECRETS_ENCRYPTION_KEY: the master keys for secrets at rest (webhook signing secrets), as `id:base64key`
 *   entries, the current one first (parseKeyring). A value that does not start with an id and a
 *   colon is a file holding them instead (a mounted secret, a file a vault agent writes). Unset:
 *   webhooks are off.
 *
 * Relative paths (STORAGE_DIR, a SECRETS_ENCRYPTION_KEY file) are resolved against INIT_CWD, where a pnpm
 * script was started (pnpm runs the server in its own package directory), else the working
 * directory.
 * - WEBHOOKS_ALLOW_HTTP: `true` allows http: endpoints (local development; default false).
 *
 * Throws on a missing or bad setting, naming it, so the server does not start half configured.
 */
export async function serverConfigFromEnv(env: Env, options: { readonly fetch?: typeof fetch } = {}): Promise<ServerConfig> {
  const e = envReader(env)
  const driver = e.oneOf('STORAGE_DRIVER', ['local', 's3'] as const, 'local')
  const region = e.value('S3_REGION')
  const storage: StorageConfig =
    driver === 'local'
      ? { driver, dir: pathOf(env, e.value('STORAGE_DIR') ?? '.data/storage') }
      : {
          driver,
          endpoint: e.required('S3_ENDPOINT'),
          bucket: e.required('S3_BUCKET'),
          accessKeyId: e.required('S3_ACCESS_KEY_ID'),
          secretAccessKey: e.required('S3_SECRET_ACCESS_KEY'),
          ...(region ? { region } : {}),
        }
  return {
    mode: e.oneOf('MODE', ['api', 'worker', 'all'] as const, 'all'),
    port: e.int('PORT', 3000, 1),
    database: databaseFromEnv(env),
    storage,
    rateLimit: { ratePerSecond: e.int('API_RATE_PER_SECOND', 10, 1), burst: e.int('API_RATE_BURST', 50, 1) },
    llm: await llmFromEnv(env, options),
    secrets: await secretsFromEnv(env),
    webhooksAllowHttp: e.oneOf('WEBHOOKS_ALLOW_HTTP', ['true', 'false'] as const, 'false') === 'true',
  }
}

/** A path from the environment, absolute: a relative one is from where the command was started. */
function pathOf(env: Env, path: string): string {
  return resolve(envReader(env).value('INIT_CWD') ?? process.cwd(), path)
}

/** A keyring value starts with its first key's id and a colon; anything else names a file. */
const KEYRING_START = /^[A-Za-z0-9_-]{1,32}:/

async function secretsFromEnv(env: Env): Promise<Keyring | null> {
  const value = envReader(env).value('SECRETS_ENCRYPTION_KEY')
  if (value === undefined) return null
  let text = value
  if (!KEYRING_START.test(value)) {
    const file = pathOf(env, value)
    try {
      text = (await readFile(file, 'utf8')).trim()
    } catch (err) {
      throw new Error(
        `SECRETS_ENCRYPTION_KEY does not start with a key id and a colon (such as k1:), so it is read as a file, and ${file} cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
      )
    }
    if (text === '') throw new Error(`SECRETS_ENCRYPTION_KEY names ${file}, which is empty`)
  }
  try {
    return parseKeyring(text)
  } catch (err) {
    const hint = value === text ? ' (to name a file whose name starts with a word and a colon, write it as ./name or an absolute path)' : ''
    throw new Error(`SECRETS_ENCRYPTION_KEY: ${(err as Error).message}${hint}`)
  }
}

function databaseFromEnv(env: Env): DatabaseConfig {
  const e = envReader(env)
  const poolMax = e.int('DATABASE_POOL_MAX', 10, 1)
  const appUrl = e.value('DATABASE_APP_URL')
  const systemUrl = e.value('DATABASE_SYSTEM_URL')
  if (appUrl && systemUrl) return { setup: 'roles', appUrl, systemUrl, poolMax }
  if (appUrl || systemUrl) throw new Error('Set both DATABASE_APP_URL and DATABASE_SYSTEM_URL, or neither (then DATABASE_URL is used)')
  const url = e.value('DATABASE_URL')
  if (!url) throw new Error('Set DATABASE_URL, or DATABASE_APP_URL and DATABASE_SYSTEM_URL')
  return { setup: 'single', url, poolMax }
}
