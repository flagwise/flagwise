// Puts the server together from its config: the database, the event bus, object storage, the
// public API (MODE api or all) and the event handlers (MODE worker or all).

import { analytics } from '@flagwise/analytics'
import { apps } from '@flagwise/apps'
import { audit } from '@flagwise/audit'
import { auth } from '@flagwise/auth'
import { classify } from '@flagwise/classify'
import { eventContract } from '@flagwise/contracts'
import { delivery } from '@flagwise/delivery'
import { disputes } from '@flagwise/disputes'
import { flagging } from '@flagwise/flagging'
import { moderation } from '@flagwise/moderation'
import { notifications } from '@flagwise/notifications'
import { policy } from '@flagwise/policy'
import { privacy } from '@flagwise/privacy'
import { scoring } from '@flagwise/scoring'
import { triage } from '@flagwise/triage'
import { systemClock, type Clock } from '@flagwise/kernel'
import {
  createDatabase,
  createPgBus,
  createPgScheduler,
  DatabaseSetupError,
  DEFAULT_ROLES,
  fileStorage,
  initSingleUser,
  memoryRateLimiter,
  pgIdempotencyStore,
  migrate,
  MigrationError,
  pendingMigrations,
  s3Storage,
  type Database,
  type ObjectStorage,
  type PgBus,
  type PgScheduler,
  type RunningService,
  type ServiceRuntime,
} from '@flagwise/platform'
import type { FlagwisePlugin } from '@flagwise/plugin-api'
import { sql } from 'drizzle-orm'
import { createApp, type App } from './app.ts'
import type { DatabaseConfig, ServerConfig, StorageConfig } from './config/server.ts'
import { ALL_MIGRATIONS } from './migrations.ts'

export interface ServerOptions {
  readonly plugins?: readonly FlagwisePlugin[]
  /** The time for the server and its event bus; default systemClock, with the bus on the database's time. */
  readonly clock?: Clock
  /** Errors outside a request: idle database clients and the bus polling loop. Default: a JSON line on stderr. */
  readonly onError?: (err: unknown) => void
  /** Why the database is not ready yet, each time the reason changes. Default: a JSON line on stdout. */
  readonly onWaiting?: (reason: string) => void
  /** Delay between database checks while waiting; default 2 000 ms. */
  readonly retryMs?: number
  /** How webhooks are posted; default fetch. */
  readonly fetch?: typeof fetch
  /** Waits before each LLM retry of a case the LLM failed on; default LLM_RETRY_DELAYS_MS. */
  readonly llmRetryDelaysMs?: readonly number[]
}

export interface Server {
  readonly app: App
  readonly db: Database
  readonly bus: PgBus
  /** The services' timers; fired from start() in MODE worker or all. */
  readonly scheduler: PgScheduler
  readonly storage: ObjectStorage
  /**
   * Makes sure the database is ready, then starts handling events (MODE worker or all); serving HTTP
   * is the caller's and can begin before, with /readyz answering 503 until this resolves. See
   * prepare(); it waits. Rejects only on a setup that waiting cannot fix.
   */
  start(): Promise<void>
  /**
   * Makes sure the database is ready for this release:
   * - One database URL: creates the app and system roles (initSingleUser) and runs pending migrations.
   * - Role URLs: checks that every migration of this release is applied (db:migrate runs elsewhere).
   *
   * With `wait` (start's default), an unreachable database or pending migrations are retried every
   * `retryMs`, reporting the reason through onWaiting, until stop(); without it they throw. A
   * DatabaseSetupError or MigrationError always throws.
   */
  prepare(options?: { readonly wait?: boolean }): Promise<void>
  /** Stops handling events, waits for the ones in progress, and closes the database pools. */
  stop(): Promise<void>
}

export function databaseOf(config: DatabaseConfig, onError: (err: Error) => void): Database {
  return config.setup === 'single'
    ? createDatabase({ appUrl: config.url, systemUrl: config.url, max: config.poolMax, assumeRoles: DEFAULT_ROLES }, onError)
    : createDatabase({ appUrl: config.appUrl, systemUrl: config.systemUrl, max: config.poolMax }, onError)
}

export function storageOf(config: StorageConfig): ObjectStorage {
  return config.driver === 'local'
    ? fileStorage({ dir: config.dir })
    : s3Storage({
        endpoint: config.endpoint,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.region ? { region: config.region } : {}),
      })
}

/**
 * Opens the database pools and boots every service from its own composition root, with only the
 * runtime (database, bus, timers, clock) and options of its own: each reacts to the others' facts
 * on the bus with its own handlers, in transactions of its own, and reads only its own tables and
 * copies.
 * - api, all: the public API, checking API keys through auth, with the services' routes.
 * - worker, all: every service's handlers on the event bus, its timers, and work of its own
 *   (delivery's webhook sender, when the config has master keys; without them no endpoint can be
 *   added, so nothing is queued).
 *
 * /readyz answers 503 until prepare() has succeeded, then checks both database pools. Nothing is
 * polled until start().
 */
export function createServer(config: ServerConfig, options: ServerOptions = {}): Server {
  const clock = options.clock ?? systemClock
  const onError = options.onError ?? ((err: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'background error', err: String((err as Error)?.stack ?? err) })))
  const onWaiting = options.onWaiting ?? ((reason: string) => console.log(JSON.stringify({ level: 'info', msg: 'waiting for the database', reason })))
  const retryMs = options.retryMs ?? 2_000
  const db = databaseOf(config.database, onError)
  const bus = createPgBus(db, { onError, contract: eventContract, ...(options.clock && { clock: options.clock }) })
  const scheduler = createPgScheduler(db, { onError, ...(options.clock && { clock: options.clock }) })
  const storage = storageOf(config.storage)
  const api = config.mode !== 'worker'
  const worker = config.mode !== 'api'

  // Each service boots from the runtime and options of its own: its handlers and timers run once
  // the bus and scheduler start (MODE worker or all), its routes are served in MODE api or all.
  const runtime: ServiceRuntime = { db, bus, scheduler, clock, onError }
  const authRunning = auth.boot(runtime)
  const running: readonly RunningService[] = [
    apps.boot(runtime),
    authRunning,
    policy.boot(runtime),
    flagging.boot(runtime, { storage }),
    classify.boot(runtime, { storage, llm: config.llm.llm, redact: config.llm.redact, ...(options.llmRetryDelaysMs && { llmRetryDelaysMs: options.llmRetryDelaysMs }) }),
    triage.boot(runtime),
    moderation.boot(runtime),
    scoring.boot(runtime),
    delivery.boot(runtime, { secrets: config.secrets, ...(options.fetch && { fetch: options.fetch }) }),
    disputes.boot(runtime),
    privacy.boot(runtime),
    notifications.boot(runtime),
    audit.boot(runtime),
    analytics.boot(runtime),
  ]

  let prepared = false
  let stopped = false
  let wake: (() => void) | undefined
  const sleep = () => new Promise<void>((resolve) => ((wake = resolve), setTimeout(resolve, retryMs).unref()))
  const attempt = async () => {
    if (config.database.setup === 'single') {
      await initSingleUser(config.database.url)
      await migrate(config.database.url, ALL_MIGRATIONS)
    }
    const pending = await pendingMigrations(db, ALL_MIGRATIONS)
    if (pending.length > 0) throw new PendingMigrations(pending)
  }
  const prepare = async ({ wait = false }: { readonly wait?: boolean } = {}) => {
    let last: string | undefined
    while (!prepared) {
      try {
        await attempt()
        prepared = true
      } catch (err) {
        if (stopped) throw new Error('Stopped before the database was ready')
        if (err instanceof DatabaseSetupError || err instanceof MigrationError || !wait) throw err
        const reason = err instanceof Error ? err.message : String(err)
        if (reason !== last) onWaiting(reason)
        last = reason
        await sleep()
        if (stopped) throw new Error('Stopped before the database was ready')
      }
    }
  }

  const app = createApp({
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(api ? { api: { keys: authRunning.keys, limiter: memoryRateLimiter(), rateLimit: config.rateLimit, clock, routes: running.flatMap((r) => (r.routes ? [r.routes] : [])), idempotency: pgIdempotencyStore(db) } } : {}),
    ready: async () => {
      if (!prepared) throw new Error('The database is not ready yet')
      await Promise.all([db.app.execute(sql`SELECT 1`), db.system.execute(sql`SELECT 1`)])
    },
  })

  return {
    app,
    db,
    bus,
    scheduler,
    storage,
    prepare,
    async start() {
      await prepare({ wait: true })
      if (worker && !stopped) {
        bus.start()
        scheduler.start()
        for (const r of running) r.start?.()
      }
    },
    async stop() {
      stopped = true
      wake?.()
      await Promise.all([bus.stop(), scheduler.stop(), ...running.map((r) => r.stop?.())])
      await db.close()
    },
  }
}

class PendingMigrations extends Error {
  constructor(pending: readonly string[]) {
    super(`${pending.length} migrations are not applied yet (${pending[0]}${pending.length > 1 ? ', ...' : ''}); run db:migrate`)
    this.name = 'PendingMigrations'
  }
}
