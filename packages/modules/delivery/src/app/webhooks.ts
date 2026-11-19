// Tenant webhooks: each app's signing secrets and endpoints (per mode), and turning internal events
// into one delivery per matching endpoint. Sending them is send-webhooks.ts.

import { FlagwiseError, type Clock, type TenantRef } from '@flagwise/kernel'
import { generateSecret } from '../domain/webhook-signature.ts'
import { matchesFilter, toWebhook, type InternalEvent } from '../domain/webhooks.ts'

/** The `api_version` of every webhook body. */
export const WEBHOOK_API_VERSION = '2026-11-01'

/** Every webhook type tenants can receive, and filter endpoints by. */
export const WEBHOOK_EVENT_TYPES = [
  'report.triaged',
  'case.untriaged',
  'action.requested',
  'account.threshold_crossed',
  'decision.notice',
  'appeal.filed',
  'appeal.resolved',
  'identifier.matched',
  'subject.erased',
] as const
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

/** Endpoints per app and mode. */
export const MAX_ENDPOINTS = 3
/** How long a rolled-over secret keeps signing, by default... */
export const DEFAULT_SECRET_OVERLAP_MS = 24 * 3_600_000
/** ...and at most. */
export const MAX_SECRET_OVERLAP_MS = 7 * 24 * 3_600_000

export interface WebhookEndpoint {
  readonly id: string
  readonly tenant: TenantRef
  readonly url: string
  /** Null: every event type. */
  readonly eventTypes: readonly WebhookEventType[] | null
  readonly createdAt: Date
}

export interface StoredSecret {
  readonly version: number
  /** Sealed with the master key; see SecretSealer. */
  readonly sealed: string
  readonly createdAt: Date
  /** Null for the current secret. */
  readonly expiresAt: Date | null
}

/** Seals and opens secrets with the install's master key; `context` binds a value to its row. */
export interface SecretSealer {
  seal(plaintext: string, context: string): string
  open(sealed: string, context: string): string
}

/** Every method only sees the given tenant's rows (org, app and mode). */
export interface WebhookStore {
  /** Until the current transaction ends, another caller locking the same app and mode waits. */
  lockApp(tenant: TenantRef): Promise<void>
  /** Newest first. */
  secrets(tenant: TenantRef): Promise<readonly StoredSecret[]>
  insertSecret(tenant: TenantRef, secret: StoredSecret): Promise<void>
  /** Every secret that would still sign at `at` (no expiry, or a later one) now expires at `at`. */
  expireSecretsBy(tenant: TenantRef, at: Date): Promise<void>
  /** Oldest first. */
  endpoints(tenant: TenantRef): Promise<readonly WebhookEndpoint[]>
  insertEndpoint(endpoint: WebhookEndpoint): Promise<void>
  /** Deletes the endpoint and fails its pending deliveries at `now`; false when there is none. */
  deleteEndpoint(tenant: TenantRef, id: string, now: Date): Promise<boolean>
  /**
   * Stores a webhook event, unless one with the same `sourceId` exists; returns the stored one
   * either way, so a redelivered internal event keeps its first id and body.
   */
  insertEvent(tenant: TenantRef, event: StoredEvent): Promise<StoredEvent>
  /** A pending delivery due at `dueAt`; nothing when the event already has one for the endpoint. */
  insertDelivery(tenant: TenantRef, delivery: { readonly eventId: string; readonly endpointId: string; readonly createdAt: Date; readonly dueAt: Date }): Promise<void>
  /** Replaces the account's id with `erasedId` in the webhook bodies that name it (`data.subject_external_id`); how many it changed. */
  eraseAccount(tenant: TenantRef, externalId: string, erasedId: string): Promise<number>
}

export interface StoredEvent {
  readonly id: string
  readonly sourceId: string
  readonly type: string
  readonly body: string
  readonly createdAt: Date
}

export interface WebhookDeps {
  readonly webhooks: WebhookStore
  readonly sealer: SecretSealer
  readonly clock: Clock
  /** Webhook event ids, `evt_` ...; and endpoint ids, `whe_` .... */
  readonly newEventId: () => string
  readonly newEndpointId: () => string
  /** Signing secrets; default generateSecret(). */
  readonly newSecret?: () => string
  /** Allow `http:` endpoint URLs (local development); default only `https:`. */
  readonly allowHttp?: boolean
}

/** What sealed secrets are bound to: the app, mode and version, so a copied value does not open elsewhere. */
export const secretContext = (tenant: TenantRef, version: number) => `delivery.webhook_secret:${tenant.orgId}:${tenant.appId}:${tenant.livemode}:${version}`

export interface RolledSecret {
  /** The new secret, `whsec_...`: shown to the caller once. */
  readonly secret: string
  readonly version: number
  /** Until when the previous secrets still sign; null when there were none. */
  readonly previousExpireAt: Date | null
}

/**
 * Makes a new signing secret for the app and mode, and keeps the previous ones signing for
 * `overlapMs` (default 24 hours, 0 to 7 days; 'validation_failed' otherwise): during the overlap
 * every webhook carries one signature per secret, so a receiver can switch without a failed
 * delivery. A secret already expiring sooner keeps its time. Rolls of one app and mode run one at a
 * time.
 */
export async function rollSecret(deps: WebhookDeps, tenant: TenantRef, options: { readonly overlapMs?: number } = {}): Promise<RolledSecret> {
  const overlapMs = options.overlapMs ?? DEFAULT_SECRET_OVERLAP_MS
  if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs > MAX_SECRET_OVERLAP_MS) {
    throw new FlagwiseError('validation_failed', 'The overlap must be from 0 to 7 days', { errors: [{ path: 'overlap', message: 'from 0 to 7 days' }] })
  }
  await deps.webhooks.lockApp(tenant)
  const now = deps.clock.now()
  const existing = await deps.webhooks.secrets(tenant)
  const previousExpireAt = existing.length > 0 ? new Date(now.getTime() + overlapMs) : null
  if (previousExpireAt) await deps.webhooks.expireSecretsBy(tenant, previousExpireAt)
  const created = await insertNewSecret(deps, tenant, (existing[0]?.version ?? 0) + 1, now)
  return { ...created, previousExpireAt }
}

async function insertNewSecret(deps: WebhookDeps, tenant: TenantRef, version: number, now: Date): Promise<{ secret: string; version: number }> {
  const secret = (deps.newSecret ?? generateSecret)()
  await deps.webhooks.insertSecret(tenant, { version, sealed: deps.sealer.seal(secret, secretContext(tenant, version)), createdAt: now, expiresAt: null })
  return { secret, version }
}

/** The secrets that sign at `now`, newest first, opened. */
export async function signingSecrets(store: Pick<WebhookStore, 'secrets'>, sealer: SecretSealer, tenant: TenantRef, now: Date): Promise<string[]> {
  const secrets = await store.secrets(tenant)
  return secrets.filter((s) => s.expiresAt === null || s.expiresAt.getTime() > now.getTime()).map((s) => sealer.open(s.sealed, secretContext(tenant, s.version)))
}

export interface AddEndpoint {
  readonly url: string
  /** Default: every event type. */
  readonly eventTypes?: readonly string[] | null
}

export interface AddedEndpoint {
  readonly endpoint: WebhookEndpoint
  /** The app's first signing secret, made with its first endpoint: shown once. Absent when the app already had one. */
  readonly secret?: string
}

/**
 * Adds an endpoint for the app and mode, at most MAX_ENDPOINTS ('conflict' beyond). The URL must be
 * absolute `https:` (`http:` too with `allowHttp`), without user or password, at most 2,048
 * characters; event types must be from WEBHOOK_EVENT_TYPES, without repeats, and at least one when
 * given. Bad input is 'validation_failed' with field errors. The app's first endpoint also makes its
 * first signing secret, returned once.
 */
export async function addEndpoint(deps: WebhookDeps, tenant: TenantRef, input: AddEndpoint): Promise<AddedEndpoint> {
  const url = checkUrl(input.url, deps.allowHttp ?? false)
  const eventTypes = checkEventTypes(input.eventTypes ?? null)
  await deps.webhooks.lockApp(tenant)
  if ((await deps.webhooks.endpoints(tenant)).length >= MAX_ENDPOINTS) {
    throw new FlagwiseError('conflict', `An app has at most ${MAX_ENDPOINTS} webhook endpoints per mode; remove one first`)
  }
  const now = deps.clock.now()
  const endpoint: WebhookEndpoint = { id: deps.newEndpointId(), tenant, url, eventTypes, createdAt: now }
  await deps.webhooks.insertEndpoint(endpoint)
  if ((await deps.webhooks.secrets(tenant)).length > 0) return { endpoint }
  const { secret } = await insertNewSecret(deps, tenant, 1, now)
  return { endpoint, secret }
}

/** Removes an endpoint; its pending deliveries fail. 'not_found' when the app has no such endpoint. */
export async function removeEndpoint(deps: Pick<WebhookDeps, 'webhooks' | 'clock'>, tenant: TenantRef, id: string): Promise<void> {
  if (!(await deps.webhooks.deleteEndpoint(tenant, id, deps.clock.now()))) throw new FlagwiseError('not_found', `No webhook endpoint ${id}`)
}

export interface EventToSend {
  /** The internal event's id, so handling it twice makes one webhook. */
  readonly sourceId: string
  readonly event: InternalEvent
}

/**
 * Turns an internal event into a webhook for the app and mode: when it is one tenants see
 * (toWebhook) and some endpoint's filter takes its type, stores the event once (a redelivered
 * internal event keeps its first id and body) and one pending delivery per such endpoint, due now.
 * Returns the number of deliveries the event has for those endpoints; 0 when none takes it, and
 * then nothing is stored.
 */
export async function enqueueWebhook(deps: Pick<WebhookDeps, 'webhooks' | 'clock' | 'newEventId'>, tenant: TenantRef, input: EventToSend): Promise<number> {
  const now = deps.clock.now()
  const id = deps.newEventId()
  const body = toWebhook(input.event, { eventId: id, apiVersion: WEBHOOK_API_VERSION, createdAt: now, livemode: tenant.livemode, appId: tenant.appId })
  if (!body) return 0
  const endpoints = (await deps.webhooks.endpoints(tenant)).filter((e) => matchesFilter(body.type, e.eventTypes))
  if (endpoints.length === 0) return 0
  const stored = await deps.webhooks.insertEvent(tenant, { id, sourceId: input.sourceId, type: body.type, body: JSON.stringify(body), createdAt: now })
  for (const e of endpoints) await deps.webhooks.insertDelivery(tenant, { eventId: stored.id, endpointId: e.id, createdAt: now, dueAt: now })
  return endpoints.length
}

const MAX_URL = 2_048

function checkUrl(raw: string, allowHttp: boolean): string {
  const invalid = (message: string) => new FlagwiseError('validation_failed', `The endpoint URL ${message}`, { errors: [{ path: 'url', message }] })
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) throw invalid(`must be 1 to ${MAX_URL} characters`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('is not an absolute URL')
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw invalid(allowHttp ? 'must be https: or http:' : 'must be https:')
  if (url.username || url.password) throw invalid('must not carry a user or password')
  return url.toString()
}

function checkEventTypes(types: readonly string[] | null): readonly WebhookEventType[] | null {
  if (types === null) return null
  const invalid = (message: string) => new FlagwiseError('validation_failed', `The event types ${message}`, { errors: [{ path: 'event_types', message }] })
  if (types.length === 0) throw invalid('must list at least one type, or be left out for every type')
  if (new Set(types).size !== types.length) throw invalid('must not repeat a type')
  const unknown = types.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t))
  if (unknown.length > 0) throw invalid(`include unknown types: ${unknown.join(', ')}`)
  return types as readonly WebhookEventType[]
}
