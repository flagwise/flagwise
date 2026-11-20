// Puts the server together from its config: the database, the event bus, object storage, the
// public API (MODE api or all) and the event handlers (MODE worker or all).

import { subscribeApps } from '@flagwise/apps'
import { auditReads, pgAuditDeps, subscribeAudit } from '@flagwise/audit'
import { pgAppCopies, subscribeAuth } from '@flagwise/auth'
import { moderationService, pgCaseReads, pgModerationDeps, subscribeModeration, type ModerationRoutesDeps } from '@flagwise/moderation'
import { classifyDepsWithPolicy, pgClassifyPolicyCopy, pgClassifyRunner, subscribeClassify, type ClassifyDeps } from '@flagwise/classify'
import { eventContract } from '@flagwise/contracts'
import {
  actionSettlement,
  createWebhookSender,
  fetchPost,
  keyringSealer,
  pgActionRequestReads,
  pgDeliveryDeps,
  pgSenderDeps,
  subscribeDelivery,
  type ActionRequestRoutesDeps,
  type WebhookSender,
} from '@flagwise/delivery'
import { pgFlaggingRunner, subscribeFlagging, type FlaggingDeps } from '@flagwise/flagging'
import { notificationsService, pgNotificationsDeps, subscribeNotifications } from '@flagwise/notifications'
import { newId, systemClock, type Clock } from '@flagwise/kernel'
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
} from '@flagwise/platform'
import type { FlagwisePlugin } from '@flagwise/plugin-api'
import { busPolicyEvents, pgPolicy, subscribePolicy } from '@flagwise/policy'
import { pgPrivacyDeps, privacyService, subscribePrivacy } from '@flagwise/privacy'
import { pgTriageDeps, subscribeTriage } from '@flagwise/triage'
import { sql } from 'drizzle-orm'
import { createApp, type App } from './app.ts'
import type { DatabaseConfig, ServerConfig, StorageConfig } from './config/server.ts'
import { pgKeyResolver } from './http/api.ts'
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
 * Opens the database pools and wires the server for its mode. The server only puts the services
 * together: each one reacts to the others' facts on the bus with its own handlers, in transactions
 * of its own, and reads only its own tables and copies.
 * - api, all: the public API, reading API keys through the system role; the routes call the
 *   services' use cases, whose events the workers handle.
 * - worker, all: every service's handlers on the event bus and its timers, with classify on the install's LLM,
 *   and delivery's webhook sender, when the config has master keys (without them no endpoint can
 *   be added, so nothing is queued).
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
  const eventId = () => newId('evt', { clock })

  const flagging: FlaggingDeps = { run: pgFlaggingRunner(db, bus), storage, clock, newReportId: () => newId('rpt', { clock }) }
  const classifyPolicy = pgClassifyPolicyCopy(db)
  const classify: ClassifyDeps = classifyDepsWithPolicy({ run: pgClassifyRunner(db), snapshots: storage, clock, llm: config.llm.llm, redact: config.llm.redact }, classifyPolicy)
  const moderation = pgModerationDeps(db, bus, {
    clock,
    newCaseId: () => newId('case', { clock }),
    newDecisionId: () => newId('dec', { clock }),
    newEventId: eventId,
  })
  const delivery = pgDeliveryDeps(db, bus, { clock, newActionRequestId: () => newId('acr', { clock }), newEventId: eventId })
  const auditLog = pgAuditDeps(db, clock)
  const privacy = pgPrivacyDeps(db, bus, { clock, newErasureId: () => newId('ers', { clock }) })
  const notifications = pgNotificationsDeps(db, bus, { clock, newNotificationId: () => newId('ntf', { clock }) })

  // Each service's handlers; they only run once the bus is started, in MODE worker or all.
  subscribeFlagging(bus, flagging)
  subscribeClassify(bus, { classify, policy: classifyPolicy, ...(options.llmRetryDelaysMs && { llmRetryDelaysMs: options.llmRetryDelaysMs }) })
  subscribeTriage(bus, pgTriageDeps(db, bus))
  subscribeModeration(bus, moderation, scheduler)
  subscribeDelivery(bus, delivery, scheduler)
  subscribeNotifications(bus, notifications)
  subscribeAudit(bus, auditLog)
  subscribePrivacy(bus, privacy)
  subscribePolicy(bus, { clock })
  subscribeApps(bus, { clock })
  subscribeAuth(bus, { apps: pgAppCopies(db), clock })

  const caseWork = moderationService(moderation)
  const cases: ModerationRoutesDeps = { read: pgCaseReads(db), ...caseWork, clock }
  const settlement = actionSettlement(delivery)
  const actionRequests: ActionRequestRoutesDeps = { read: pgActionRequestReads(db), confirm: settlement.confirm, fail: settlement.fail }
  const appConfig = pgPolicy(db, { clock, events: (tx) => busPolicyEvents(bus, tx, eventId) })
  const audit = auditReads(auditLog)
  const erasures = { ...privacyService(privacy), clock }
  const sender: WebhookSender | undefined =
    worker && config.secrets
      ? createWebhookSender(pgSenderDeps(db, { sealer: keyringSealer(config.secrets), clock, post: fetchPost(options.fetch) }), { onError })
      : undefined

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
    ...(api ? { api: { keys: pgKeyResolver(db), limiter: memoryRateLimiter(), rateLimit: config.rateLimit, clock, flagging, cases, classify, actionRequests, config: appConfig, audit, privacy: erasures, notifications: notificationsService(notifications), idempotency: pgIdempotencyStore(db) } } : {}),
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
        sender?.start()
      }
    },
    async stop() {
      stopped = true
      wake?.()
      await Promise.all([bus.stop(), scheduler.stop(), sender?.stop()])
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
