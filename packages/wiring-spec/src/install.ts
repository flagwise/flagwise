// One Flagwise install for a scenario file: a fresh database, the server as a self-hoster runs it
// (MODE all, one process), an LLM and a webhook receiver over HTTP, and members with admin keys.
// Scenarios use only what a tenant or an operator has: the public API, webhooks, the setup
// functions of the CLI, and the facts on the bus.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TenantRef } from '@flagwise/kernel'
import pg from 'pg'
import { newKeyringEntry } from '@flagwise/platform'
import { createTestDatabase, type TestDatabase } from '@flagwise/platform/testing'
import { addWebhookEndpoint, bootstrap, createKey, createServer, migrateFromEnv, serverConfigFromEnv, type Server } from '@flagwise/server'
import { skippingClock, type SkippingClock } from './clock.ts'
import { fakeNet, LLM_BASE_URL, WEBHOOK_URL, type FakeNet } from './net.ts'
import { recordSeen } from './seen.ts'

export interface Member {
  readonly id: string
  readonly key: string
}

export interface Fact {
  readonly seq: number
  readonly type: string
  readonly key: string
  readonly data: any
  readonly schemaVersion: string | null
}

export interface Install {
  readonly clock: SkippingClock
  readonly net: FakeNet
  readonly tenant: TenantRef
  /** The app's live flagging key, as the tenant's backend holds it. */
  readonly flaggingKey: string
  /** Two moderators with admin keys. */
  readonly jane: Member
  readonly john: Member
  /** Calls the public API under /v1 and returns the status and the JSON body. */
  call(key: string, path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>
  /** The facts published so far, in order. */
  facts(): Promise<readonly Fact[]>
  /** Stops the server, records the event types and consumer groups seen for the scoreboard, and drops the database. */
  stop(): Promise<void>
}

/** Starts an install named `name` (used for the scoreboard's record of seen event types). */
export async function startInstall(name: string): Promise<Install> {
  const db: TestDatabase = await createTestDatabase()
  let server: Server | undefined
  try {
    const net = fakeNet()
    const clock = skippingClock()
    const env = {
      DATABASE_APP_URL: db.appUrl,
      DATABASE_SYSTEM_URL: db.systemUrl,
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'wiring-evidence-')),
      SECRETS_ENCRYPTION_KEY: newKeyringEntry('k1', () => new Uint8Array(32).fill(7)),
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL,
      LLM_MODEL: 'small',
    }
    await migrateFromEnv({ DATABASE_OWNER_URL: db.ownerUrl, DATABASE_APP_URL: `postgres://${db.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${db.roles.system}@x/x` })
    const config = await serverConfigFromEnv(env, { fetch: net.fetch })
    const installed = await bootstrap(config, { orgName: 'Jane Doe Dating', appName: 'Jane Doe Dating iOS' }, clock)
    const tenant: TenantRef = { orgId: installed.org.id, appId: installed.app.id, livemode: true }
    const jane = await createKey(config, { ...tenant, scopes: ['admin'] })
    const john = await createKey(config, { ...tenant, scopes: ['admin'] })
    await addWebhookEndpoint(config, tenant, { url: WEBHOOK_URL }, clock)
    server = createServer(config, { clock, fetch: net.fetch, onError: () => {} })
    await server.start()
    const running = server

    return {
      clock,
      net,
      tenant,
      flaggingKey: installed.liveKey,
      jane: { id: jane.id, key: jane.key },
      john: { id: john.id, key: john.key },
      async call(key, path, init = {}) {
        const res = await running.app.http.request(`/v1${path}`, {
          method: init.method ?? 'GET',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        })
        const text = await res.text()
        return { status: res.status, body: text ? JSON.parse(text) : null }
      },
      async facts() {
        return (await running.bus.log()).map(({ seq, event }) => ({ seq, type: event.type, key: event.key, data: event.data, schemaVersion: event.schemaVersion ?? null }))
      },
      async stop() {
        try {
          const events: Record<string, (string | null)[]> = {}
          for (const { event } of await running.bus.log()) {
            const versions = (events[event.type] ??= [])
            if (!versions.includes(event.schemaVersion ?? null)) versions.push(event.schemaVersion ?? null)
          }
          const client = new pg.Client({ connectionString: db.systemUrl })
          await client.connect()
          const rows = await client.query<{ name: string; types: string[] | null }>('SELECT name, types FROM platform.consumer_groups ORDER BY name').finally(() => client.end())
          recordSeen(name, { events, groups: Object.fromEntries(rows.rows.map((r) => [r.name, r.types])) })
        } finally {
          await running.stop()
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
