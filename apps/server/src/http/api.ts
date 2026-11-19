// The public API edge: request ids, API-key authentication, rate limits, problem+json errors and
// routing to the modules' routes. No business logic lives here.

import { createHash, randomUUID } from 'node:crypto'
import { FlagwiseError, toProblem, type Clock, type TenantContext } from '@flagwise/kernel'
import { runInRequest, withSystem, type BucketConfig, type Database, type IdempotencyStore, type RateLimiter } from '@flagwise/platform'
import { auditRoutes, type AuditRoutesDeps } from '@flagwise/audit'
import { moderationRoutes, type ModerationRoutesDeps } from '@flagwise/moderation'
import { classifyRoutes, type ClassifyDeps } from '@flagwise/classify'
import { deliveryRoutes, type ActionRequestRoutesDeps } from '@flagwise/delivery'
import { flaggingRoutes, type FlaggingDeps } from '@flagwise/flagging'
import { policyRoutes, type PolicyRoutesDeps } from '@flagwise/policy'
import { privacyRoutes, type PrivacyRoutesDeps } from '@flagwise/privacy'
import { pgKeyDirectory, resolveApiKey, type KeyResolution } from '@flagwise/tenancy'
import { Hono, type Context } from 'hono'

export interface ApiDeps {
  /** Resolves a presented API key to its tenant. */
  readonly keys: { resolve(key: string, now: Date): Promise<KeyResolution> }
  readonly limiter: RateLimiter
  /** The token bucket of each app (self-host: from config). */
  readonly rateLimit: BucketConfig
  readonly clock: Clock
  readonly flagging: FlaggingDeps
  /** The case routes; left out, they answer 404 like any unknown path. */
  readonly cases?: ModerationRoutesDeps
  /** The classification route; left out, it answers 404. */
  readonly classify?: Pick<ClassifyDeps, 'run'>
  /** The action request routes; left out, they answer 404. */
  readonly actionRequests?: ActionRequestRoutesDeps
  /** The app config routes (action keys); left out, they answer 404. */
  readonly config?: PolicyRoutesDeps
  /** The audit routes; left out, they answer 404. */
  readonly audit?: AuditRoutesDeps
  /** The erasure routes; left out, they answer 404. */
  readonly privacy?: PrivacyRoutesDeps
  /** Where Idempotency-Keys of POST requests are kept; left out, the header is ignored. */
  readonly idempotency?: IdempotencyStore
  /** Called with errors that become a 500, for logging; default writes a JSON line to stderr. */
  readonly onError?: (err: unknown, requestId: string) => void
}

interface ApiEnv {
  Variables: { tenant: TenantContext; requestId: string }
}

const REQUEST_ID = /^[A-Za-z0-9_.-]{1,128}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/

/** Resolves keys through the key directory, which the system role reads. */
export function pgKeyResolver(db: Database): ApiDeps['keys'] {
  return { resolve: (key, now) => withSystem(db, (tx) => resolveApiKey(pgKeyDirectory(tx), key, now)) }
}

/**
 * The `/v1` API. Every request gets a request id (a valid incoming `X-Request-Id`, else a new
 * `req_` id), echoed in `X-Request-Id` and in every problem body.
 *
 * Auth: `Authorization: Bearer <key>`. No key, a malformed or unknown one, or a revoked or expired
 * one is 401 with `WWW-Authenticate: Bearer`; a key of a deleted app is 410.
 *
 * Every event published while handling an authenticated request carries the request id and the API
 * key as its actor (runInRequest), for the audit log.
 *
 * Rate limit: one token bucket per app and mode; an empty bucket is 429 with `Retry-After`.
 *
 * Idempotency: a POST with an `Idempotency-Key` header (1 to 255 visible ASCII characters, else
 * 400) runs once per app and mode within 24 hours. A retry with the same method, path and body
 * gets the first response with `Idempotent-Replayed: true`; the key with another request, or while
 * the first one still runs, is 409. A response of 500 or more is not kept, so a retry runs again.
 * `POST /reports` keeps its own key with the report, in the same transaction.
 *
 * Errors: a thrown FlagwiseError becomes its problem+json (`Retry-After` when it has one); any other
 * error is a 500 internal_error without details and goes to `onError`. Unknown paths are 404.
 */
export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>()
  const logError = deps.onError ?? ((err, requestId) => console.error(JSON.stringify({ level: 'error', msg: 'request failed', request_id: requestId, err: String((err as Error)?.stack ?? err) })))

  api.use(async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : `req_${randomUUID().replaceAll('-', '')}`
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    await next()
  })

  api.use(async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')
    if (!match) throw unauthorized('Send the API key as Authorization: Bearer <key>')
    const resolution = await deps.keys.resolve(match[1]!, deps.clock.now())
    if (!resolution.ok) {
      if (resolution.reason === 'app_deleted') throw new FlagwiseError('gone', 'The app of this API key was deleted')
      throw unauthorized(resolution.reason === 'inactive' ? 'The API key was revoked or has expired' : 'The API key is not valid')
    }
    c.set('tenant', resolution.context)
    // Events published while handling the request carry its id and the key as their actor.
    await runInRequest({ requestId: c.get('requestId'), actor: actorRef(resolution.context.actor) }, next)
  })

  api.use(async (c, next) => {
    const { appId, livemode } = c.get('tenant')
    const taken = await deps.limiter.take(`${appId}:${livemode}`, deps.rateLimit, deps.clock.now().getTime())
    if (!taken.allowed) throw new FlagwiseError('rate_limited', 'Too many requests for this app', { retryAfterSeconds: taken.retryAfterSeconds })
    await next()
  })

  api.use(async (c, next) => {
    const key = c.req.header('idempotency-key')
    const { appId, livemode } = c.get('tenant')
    if (!deps.idempotency || c.req.method !== 'POST' || key === undefined || !appId || c.req.path.endsWith('/flagging/reports')) return next()
    if (!IDEMPOTENCY_KEY.test(key)) throw new FlagwiseError('invalid_request', 'Idempotency-Key must be 1 to 255 visible ASCII characters')
    const tenant = { appId, livemode }
    const fingerprint = createHash('sha256').update(`POST ${c.req.path}\n`).update(await c.req.text()).digest('hex')
    const started = await deps.idempotency.start(tenant, key, fingerprint, deps.clock.now())
    if (started.kind === 'mismatch') throw new FlagwiseError('conflict', 'This Idempotency-Key was used with a different request')
    if (started.kind === 'in_progress') throw new FlagwiseError('conflict', 'A request with this Idempotency-Key is still running')
    if (started.kind === 'replay') {
      const { status, contentType, body } = started.response
      return c.body(body, status as 200, { 'content-type': contentType, 'idempotent-replayed': 'true' })
    }
    try {
      await next()
    } catch (err) {
      await deps.idempotency.release(tenant, key, fingerprint)
      throw err
    }
    if (c.res.status >= 500) return deps.idempotency.release(tenant, key, fingerprint)
    const body = await c.res.clone().text()
    await deps.idempotency.finish(tenant, key, fingerprint, { status: c.res.status, contentType: c.res.headers.get('content-type') ?? 'application/json', body })
  })

  api.route('/', flaggingRoutes(deps.flagging))
  if (deps.cases) api.route('/', moderationRoutes(deps.cases))
  if (deps.classify) api.route('/', classifyRoutes(deps.classify))
  if (deps.actionRequests) api.route('/', deliveryRoutes(deps.actionRequests))
  if (deps.config) api.route('/', policyRoutes(deps.config))
  if (deps.audit) api.route('/', auditRoutes(deps.audit))
  if (deps.privacy) api.route('/', privacyRoutes(deps.privacy))
  api.all('*', () => {
    throw new FlagwiseError('not_found', 'No such endpoint')
  })

  api.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown'
    if (!(err instanceof FlagwiseError)) logError(err, requestId)
    return problem(c, err, requestId)
  })

  return api
}

/** The actor as the audit log names it: embedded staff as `embed:{sub}`. */
function actorRef(actor: TenantContext['actor']): { type: string; id: string } {
  if (actor.type === 'embed') return { type: 'embed', id: `embed:${actor.sub}` }
  if (actor.type === 'system') return { type: 'system', id: 'system' }
  return { type: actor.type, id: actor.id }
}

const unauthorized = (detail: string) => new FlagwiseError('unauthorized', detail)

function problem(c: Context, err: unknown, requestId: string): Response {
  const body = toProblem(err, requestId)
  const headers: Record<string, string> = { 'content-type': 'application/problem+json', 'x-request-id': requestId }
  if (err instanceof FlagwiseError && err.retryAfterSeconds !== undefined) headers['retry-after'] = String(err.retryAfterSeconds)
  if (err instanceof FlagwiseError && err.code === 'unauthorized') headers['www-authenticate'] = 'Bearer'
  return c.body(JSON.stringify(body), body.status as 401, headers)
}
