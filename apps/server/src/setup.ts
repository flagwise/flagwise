// Setting up an install: the database roles, the migrations, and the first app and its API keys.
// Each step is safe to run again and needs only its own URL. With separate role URLs they run from
// the CLI with roles the server never gets; with one DATABASE_URL the server does the first two.

import { mkdir } from 'node:fs/promises'
import { newId, systemClock, type Clock } from '@flagwise/kernel'
import { DEFAULT_ROLES, initDatabase, initSingleUser, migrate, runInRequest, s3Storage, withSystem, withTenant, type DbRoleNames, type TenantTx } from '@flagwise/platform'
import {
  addEndpoint,
  keyringSealer,
  pgWebhookStore,
  removeEndpoint,
  resealWebhookSecrets,
  rollSecret,
  type AddedEndpoint,
  type RolledSecret,
  type WebhookDeps,
  type WebhookEndpoint,
} from '@flagwise/delivery'
import type { TenantRef } from '@flagwise/kernel'
import { busPolicyEvents, pgPolicy, PRESETS, type PresetName } from '@flagwise/policy'
import { busTenancyEvents, createApp as createRegistryApp, issueApiKey, pgTenancyStore, type App } from '@flagwise/tenancy'
import { envReader, type Env } from './config/env.ts'
import type { ServerConfig } from './config/server.ts'
import { ALL_MIGRATIONS } from './migrations.ts'
import { createServer, type Server } from './server.ts'

const ROLE_URLS = ['DATABASE_OWNER_URL', 'DATABASE_APP_URL', 'DATABASE_SYSTEM_URL'] as const

interface RoleUrls {
  readonly roles: DbRoleNames
  readonly passwords: Readonly<Record<keyof DbRoleNames, string>>
  readonly database: string
}

/** The three role URLs must point at one database; role names and passwords come from them. */
function roleUrls(env: Env): RoleUrls {
  const e = envReader(env)
  const urls = { owner: e.required('DATABASE_OWNER_URL'), app: e.required('DATABASE_APP_URL'), system: e.required('DATABASE_SYSTEM_URL') }
  const parsed = Object.fromEntries(
    Object.entries(urls).map(([role, raw]) => {
      const url = new URL(raw)
      return [role, { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), host: url.host }]
    }),
  ) as Record<keyof DbRoleNames, { user: string; password: string; database: string; host: string }>
  const { owner, app, system } = parsed
  if (app.database !== owner.database || system.database !== owner.database || app.host !== owner.host || system.host !== owner.host) {
    throw new Error('DATABASE_OWNER_URL, DATABASE_APP_URL and DATABASE_SYSTEM_URL must point at the same database')
  }
  return {
    roles: { owner: owner.user, app: app.user, system: system.user },
    passwords: { owner: owner.password, app: app.password, system: system.password },
    database: owner.database,
  }
}

const userOf = (url: string | undefined) => (url ? decodeURIComponent(new URL(url).username) : undefined)

/**
 * `flagwise db:init`, safe to run again:
 * - With any of DATABASE_OWNER_URL, DATABASE_APP_URL and DATABASE_SYSTEM_URL (then all three are
 *   required): creates the database and those login roles with their passwords, connecting as
 *   DATABASE_ADMIN_URL, else DATABASE_URL.
 * - Else, with DATABASE_URL: creates the app and system roles for it (initSingleUser). The server
 *   and db:migrate do this too, so this step is optional there.
 */
export async function initDatabaseFromEnv(env: Env): Promise<void> {
  const e = envReader(env)
  if (ROLE_URLS.some((name) => e.value(name))) {
    const { roles, passwords, database } = roleUrls(env)
    const adminUrl = e.value('DATABASE_ADMIN_URL') ?? e.value('DATABASE_URL')
    if (!adminUrl) throw new Error('Set DATABASE_ADMIN_URL (or DATABASE_URL): a user that can create roles')
    await initDatabase({ adminUrl, database, roles, passwords })
    return
  }
  const url = e.value('DATABASE_URL')
  if (!url) throw new Error('Set DATABASE_URL, or DATABASE_OWNER_URL, DATABASE_APP_URL and DATABASE_SYSTEM_URL')
  await initSingleUser(url)
}

/**
 * `flagwise db:migrate`: runs every pending migration as DATABASE_OWNER_URL, else DATABASE_URL;
 * returns their names. Only that URL is needed; the app and system role names come from their URLs
 * when set, else the defaults (fw_app, fw_system). With DATABASE_URL alone (the single-URL setup),
 * the roles are created first.
 */
export async function migrateFromEnv(env: Env): Promise<string[]> {
  const e = envReader(env)
  const owner = e.value('DATABASE_OWNER_URL')
  const ownerUrl = owner ?? e.value('DATABASE_URL')
  if (!ownerUrl) throw new Error('Set DATABASE_OWNER_URL or DATABASE_URL')
  const app = userOf(e.value('DATABASE_APP_URL'))
  const system = userOf(e.value('DATABASE_SYSTEM_URL'))
  if (!owner && !app && !system) await initSingleUser(ownerUrl)
  const roles: DbRoleNames = { owner: userOf(ownerUrl)!, app: app ?? DEFAULT_ROLES.app, system: system ?? DEFAULT_ROLES.system }
  return migrate(ownerUrl, ALL_MIGRATIONS, roles)
}

export interface Bootstrapped {
  readonly app: App
  /** Shown once, never stored. */
  readonly liveKey: string
  readonly testKey: string
}

/**
 * `flagwise bootstrap`: creates an app and a live and a test API key for it (flagging and
 * actions scopes), after preparing what the server needs before its first request: the database
 * (server.prepare without waiting: with one URL it migrates, with role URLs pending migrations
 * throw), the storage (the bucket or directory) and the event bus's consumer groups. A group only receives events
 * published after it is stored, and no report can arrive before the first key exists, so storing
 * them here means no event is missed. Each run creates another app. With `preset`, the app starts
 * with that preset's categories, in live and test mode.
 */
export function bootstrap(config: ServerConfig, input: BootstrapInput, clock: Clock = systemClock): Promise<Bootstrapped> {
  return asOperator(() => bootstrapAsOperator(config, input, clock))
}

export interface BootstrapInput {
  readonly appName: string
  readonly preset?: PresetName
}

async function bootstrapAsOperator(config: ServerConfig, input: BootstrapInput, clock: Clock): Promise<Bootstrapped> {
  if (config.storage.driver === 'local') await mkdir(config.storage.dir, { recursive: true, mode: 0o700 })
  else {
    const { driver: _driver, ...s3 } = config.storage
    await s3Storage(s3).ensureBucket()
  }

  const server = createServer({ ...config, mode: 'worker' }, { clock })
  try {
    await server.prepare()
    await server.bus.drain()
    const appId = newId('app', { clock })
    const scopes = ['flagging', 'actions']
    // Each mode in its own transaction: a key's event is written in its own mode.
    const live = await withTenant(server.db, { appIds: [appId], livemode: true }, async (tx) => {
      const deps = registryDeps(server, tx, clock)
      const app = await createRegistryApp(deps, { id: appId, name: input.appName })
      return { app, key: (await issueApiKey(deps, { appId, livemode: true, scopes })).key }
    })
    const test = await withTenant(server.db, { appIds: [appId], livemode: false }, async (tx) => {
      return issueApiKey(registryDeps(server, tx, clock), { appId, livemode: false, scopes })
    })
    // The preset is the policy service's to apply, in its own transaction per mode.
    if (input.preset) {
      const policy = pgPolicy(server.db, { clock, events: (tx) => busPolicyEvents(server.bus, tx, () => newId('evt', { clock })) })
      for (const livemode of [true, false]) await policy.replaceCategories({ appId, livemode }, PRESETS[input.preset])
    }
    return { app: live.app, liveKey: live.key, testKey: test.key }
  } finally {
    await server.stop()
  }
}

export interface CreatedKey {
  /** Shown once, never stored. */
  readonly key: string
  readonly id: string
  readonly scopes: readonly string[]
  readonly livemode: boolean
}

/**
 * `flagwise keys:create`: issues an API key for an existing app, with the given scopes (`flagging`,
 * `actions`, `admin`) and mode. Bootstrap gives only flagging and actions keys, so an admin key (the
 * case endpoints) is always asked for on purpose. Pending migrations throw, as in bootstrap.
 */
export function createKey(
  config: ServerConfig,
  input: { readonly appId: string; readonly scopes: readonly string[]; readonly livemode: boolean },
  clock: Clock = systemClock,
): Promise<CreatedKey> {
  return asOperator(() => createKeyAsOperator(config, input, clock))
}

async function createKeyAsOperator(
  config: ServerConfig,
  input: { readonly appId: string; readonly scopes: readonly string[]; readonly livemode: boolean },
  clock: Clock,
): Promise<CreatedKey> {
  const server = createServer({ ...config, mode: 'api' }, { clock })
  try {
    await server.prepare()
    return await withTenant(server.db, { appIds: [input.appId], livemode: input.livemode }, async (tx) => {
      const issued = await issueApiKey(registryDeps(server, tx, clock), { appId: input.appId, livemode: input.livemode, scopes: input.scopes })
      return { key: issued.key, id: issued.record.id, scopes: issued.record.scopes, livemode: issued.record.livemode }
    })
  } finally {
    await server.stop()
  }
}

/** The operator running the CLI: the actor of what its commands change. */
const OPERATOR = { type: 'operator', id: 'cli' } as const

/** Runs `fn` with the operator as the actor of every event it publishes. */
const asOperator = <T>(fn: () => Promise<T>): Promise<T> => runInRequest({ actor: OPERATOR }, fn)

/** The registry's deps on `tx`, publishing key changes in it. */
function registryDeps(server: Server, tx: TenantTx, clock: Clock) {
  return {
    store: pgTenancyStore(tx),
    clock,
    newId: (prefix: 'app' | 'key') => newId(prefix, { clock }),
    events: busTenancyEvents(server.bus, tx, () => newId('evt', { clock })),
  }
}

/** Runs `fn` with the webhook use cases' deps for one app and mode, on a prepared server (pending migrations throw). */
async function withWebhooks<T>(config: ServerConfig, tenant: TenantRef, clock: Clock, fn: (deps: WebhookDeps) => Promise<T>): Promise<T> {
  const server = createServer({ ...config, mode: 'api' }, { clock })
  try {
    await server.prepare()
    return await withTenant(server.db, { appIds: [tenant.appId], livemode: tenant.livemode }, (tx) =>
      fn({
        webhooks: pgWebhookStore(tx),
        // Listing and removing never seal; adding and rolling check for the keys first.
        sealer: config.secrets ? keyringSealer(config.secrets) : { seal: noKeys, open: noKeys },
        clock,
        newEventId: () => newId('evt', { clock }),
        newEndpointId: () => newId('whe', { clock }),
        allowHttp: config.webhooksAllowHttp,
      }),
    )
  } finally {
    await server.stop()
  }
}

const noKeys = (): never => {
  throw new Error('Set SECRETS_ENCRYPTION_KEY first: signing secrets are stored sealed with it (secrets:new-key makes one)')
}

/** `flagwise webhooks:add`: adds an endpoint; the app's first one also makes its signing secret, returned once. Needs the master keys. */
export async function addWebhookEndpoint(config: ServerConfig, tenant: TenantRef, input: { readonly url: string; readonly eventTypes?: readonly string[] }, clock: Clock = systemClock): Promise<AddedEndpoint> {
  if (!config.secrets) noKeys()
  return withWebhooks(config, tenant, clock, (deps) => addEndpoint(deps, tenant, input))
}

/** `flagwise webhooks:list`: the app's endpoints in the mode, oldest first. */
export function listWebhookEndpoints(config: ServerConfig, tenant: TenantRef, clock: Clock = systemClock): Promise<readonly WebhookEndpoint[]> {
  return withWebhooks(config, tenant, clock, (deps) => deps.webhooks.endpoints(tenant))
}

/** `flagwise webhooks:remove`: removes an endpoint; its pending deliveries fail. */
export function removeWebhookEndpoint(config: ServerConfig, tenant: TenantRef, id: string, clock: Clock = systemClock): Promise<void> {
  return withWebhooks(config, tenant, clock, (deps) => removeEndpoint(deps, tenant, id))
}

/** `flagwise webhooks:roll-secret`: a new signing secret, returned once; the old ones sign until the overlap ends. Needs the master keys. */
export async function rollWebhookSecret(config: ServerConfig, tenant: TenantRef, overlapMs: number, clock: Clock = systemClock): Promise<RolledSecret> {
  if (!config.secrets) noKeys()
  return withWebhooks(config, tenant, clock, (deps) => rollSecret(deps, tenant, { overlapMs }))
}

/**
 * `flagwise secrets:rewrap`: reseals every stored secret with the current master key (the first in
 * SECRETS_ENCRYPTION_KEY), as the system role in one transaction; returns how many changed. Run it after
 * putting a new key first and keeping the old one after it; then the old one can be dropped.
 */
export async function rewrapSecrets(config: ServerConfig, clock: Clock = systemClock): Promise<number> {
  if (!config.secrets) noKeys()
  const server = createServer({ ...config, mode: 'api' }, { clock })
  try {
    await server.prepare()
    return await withSystem(server.db, (tx) => resealWebhookSecrets(tx, keyringSealer(config.secrets!)))
  } finally {
    await server.stop()
  }
}
