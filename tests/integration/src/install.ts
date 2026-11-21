// One Flagwise install for a scenario file: a fresh database, the server as a self-hoster runs it
// (MODE all, one process), an LLM and a webhook receiver over HTTP, and members with admin keys.
// Scenarios use only what a tenant or an operator has: the public API, webhooks and the setup
// functions of the CLI.

import type { AppRef } from '@flagwise/kernel'
import { newKeyringEntry } from '@flagwise/platform'
import { createTestDatabase, testStorageEnv, type TestDatabase } from '@flagwise/platform/testing'
import { addWebhookEndpoint, bootstrap, createKey, createServer, migrateFromEnv, serverConfigFromEnv, type Server, type ServerConfig } from '@flagwise/server'
import { skippingClock, type SkippingClock } from './clock.ts'
import { fakeNet, LLM_BASE_URL, WEBHOOK_URL, type FakeNet } from './net.ts'

export interface Member {
  readonly id: string
  readonly key: string
}

export interface InstallOptions {
  /** The categories the app starts with, as `flagwise bootstrap --preset` gives them. */
  readonly preset?: 'dating' | 'marketplace' | 'community'
  /** Each app's token bucket; default one the scenarios' polling never empties. */
  readonly rateLimit?: { readonly perSecond: number; readonly burst: number }
}

export interface Install {
  readonly clock: SkippingClock
  readonly net: FakeNet
  readonly appRef: AppRef
  /** The app's live flagging key, as the tenant's backend holds it. */
  readonly flaggingKey: string
  /** The app's test-mode flagging key. */
  readonly testKey: string
  /** The webhook endpoint's signing secret, as the tenant keeps it to check signatures. */
  readonly webhookSecret: string
  /** The operator's settings and the config read from them, for the CLI's setup commands. */
  readonly env: Readonly<Record<string, string>>
  readonly config: ServerConfig
  /** Two moderators with admin keys. */
  readonly jane: Member
  readonly john: Member
  /**
   * Calls the public API under /v1 with `key` as the bearer key (none when null) and returns the
   * status, the JSON body and the headers; `raw` sends a body as given instead of as JSON.
   */
  call(key: string | null, path: string, init?: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>
  /** Stops the server and drops the database. */
  stop(): Promise<void>
}

/** Starts an install. */
export async function startInstall(options: InstallOptions = {}): Promise<Install> {
  const db: TestDatabase = await createTestDatabase()
  let server: Server | undefined
  try {
    const net = fakeNet()
    const clock = skippingClock()
    const env = {
      DATABASE_APP_URL: db.appUrl,
      DATABASE_SYSTEM_URL: db.systemUrl,
      ...testStorageEnv(),
      SECRETS_ENCRYPTION_KEY: newKeyringEntry('k1', () => new Uint8Array(32).fill(7)),
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL,
      LLM_MODEL: 'small',
      // Scenarios poll the API while waiting, so the bucket is large unless a scenario sets one.
      API_RATE_PER_SECOND: String(options.rateLimit?.perSecond ?? 1000),
      API_RATE_BURST: String(options.rateLimit?.burst ?? 1000),
    }
    await migrateFromEnv({ DATABASE_OWNER_URL: db.ownerUrl, DATABASE_APP_URL: `postgres://${db.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${db.roles.system}@x/x` })
    const config = await serverConfigFromEnv(env, { fetch: net.fetch })
    const installed = await bootstrap(config, { appName: 'Jane Doe Dating iOS', ...(options.preset && { preset: options.preset }) }, clock)
    const appRef: AppRef = { appId: installed.app.id, livemode: true }
    const jane = await createKey(config, { ...appRef, scopes: ['admin'] })
    const john = await createKey(config, { ...appRef, scopes: ['admin'] })
    const endpoint = await addWebhookEndpoint(config, appRef, { url: WEBHOOK_URL }, clock)
    server = createServer(config, { clock, fetch: net.fetch, onError: () => {} })
    await server.start()
    const running = server

    return {
      clock,
      net,
      appRef,
      flaggingKey: installed.liveKey,
      testKey: installed.testKey,
      webhookSecret: endpoint.secret!,
      env,
      config,
      jane: { id: jane.id, key: jane.key },
      john: { id: john.id, key: john.key },
      async call(key, path, init = {}) {
        const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined)
        const res = await running.app.http.request(`/v1${path}`, {
          method: init.method ?? (body === undefined ? 'GET' : 'POST'),
          headers: { ...(key !== null && { authorization: `Bearer ${key}` }), 'content-type': 'application/json', ...init.headers },
          ...(body !== undefined && { body }),
        })
        const text = await res.text()
        return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
      },
      async stop() {
        try {
          await running.stop()
        } finally {
          await db.drop()
        }
      },
    }
  } catch (err) {
    await server?.stop().catch(() => {})
    await db.drop().catch(() => {})
    throw err
  }
}

/** Resolves once `check` resolves to a value other than undefined, polling every 50 ms for up to 15 s. */
export async function eventually<T>(check: () => Promise<T | undefined> | T | undefined, what = 'the expected state'): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
