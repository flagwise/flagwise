// Sending webhook deliveries: lease the due ones across tenants, sign each with the app's current
// secrets, post it, and record the attempt with the retry schedule (domain/retry.ts).

import type { Clock, TenantRef } from '@flagwise/kernel'
import { isDelivered, nextAttemptAt } from '../domain/retry.ts'
import { signatureHeaders } from '../domain/webhook-signature.ts'
import { signingSecrets, type SecretSealer, type WebhookStore } from './webhooks.ts'

/** A delivery the sender has leased: which tenant, event and endpoint. */
export interface DueDelivery {
  readonly tenant: TenantRef
  readonly eventId: string
  readonly endpointId: string
}

/** Across tenants: finds due deliveries and leases them, so two senders never send one at once. */
export interface WebhookOutbox {
  /**
   * Leases up to `limit` pending deliveries due at `now` that no sender holds (or whose lease ran
   * out), oldest due first, at most `perEndpoint` held at once per endpoint, until `now + leaseMs`.
   */
  leaseDue(now: Date, options: { readonly limit: number; readonly leaseMs: number; readonly perEndpoint: number }): Promise<readonly DueDelivery[]>
}

/** What sending one leased delivery reads and writes, in the delivery's tenant. */
export interface SendStore extends Pick<WebhookStore, 'secrets'> {
  /** The delivery while still pending, with what sending it needs; null otherwise. */
  pendingDelivery(tenant: TenantRef, eventId: string, endpointId: string): Promise<PendingDelivery | null>
  /**
   * Records attempt number `attempt.number` and moves the delivery on, only while it still has
   * `attempt.number - 1` attempts (else another sender recorded it first, and nothing changes):
   * delivered, failed (no next attempt), or pending until `nextAt`. Clears the lease.
   */
  recordAttempt(tenant: TenantRef, eventId: string, endpointId: string, attempt: RecordedAttempt): Promise<void>
}

export interface PendingDelivery {
  readonly attempts: number
  readonly body: string
  /** Null when the endpoint was removed. */
  readonly url: string | null
}

export interface RecordedAttempt {
  readonly number: number
  readonly at: Date
  readonly status: number | null
  readonly durationMs: number
  readonly delivered: boolean
  readonly error: string | null
  /** When to try again; null when delivered or out of attempts. */
  readonly nextAt: Date | null
}

/** The answer to one post: the status, or null and why when no response arrived. */
export interface PostResult {
  readonly status: number | null
  readonly error?: string
}

export interface SenderDeps {
  readonly outbox: WebhookOutbox
  /** Runs `fn` in a transaction of the tenant. */
  inTenant<T>(tenant: TenantRef, fn: (store: SendStore) => Promise<T>): Promise<T>
  readonly sealer: SecretSealer
  readonly clock: Clock
  /** Posts `body` with `headers`; must give up after `timeoutMs` and not follow redirects. */
  post(url: string, request: { readonly headers: Readonly<Record<string, string>>; readonly body: string }, timeoutMs: number): Promise<PostResult>
}

export interface SendOptions {
  /** Deliveries leased per round; default 50. */
  readonly limit?: number
  /** Deliveries held at once per endpoint; default 5. */
  readonly perEndpoint?: number
  /** Per post; default 10 seconds, the limit for counting as delivered. */
  readonly timeoutMs?: number
}

/** A post longer than this is a failed attempt. */
export const SEND_TIMEOUT_MS = 10_000

/**
 * One round: leases due deliveries and sends them all at once; returns how many it attempted.
 *
 * Each one, unless it is no longer pending (another sender finished it), is signed with the app's
 * signing secrets at the attempt's time (one signature per secret, so a rolled secret keeps
 * working during its overlap) and posted with `content-type: application/json`. A 2xx within the
 * timeout is delivered; anything else is retried on the schedule of nextAttemptAt, then failed. A
 * delivery whose endpoint was removed, or whose app has no signing secret left, fails without a
 * post. A lease is long enough for the post, so an attempt is recorded once.
 */
export async function sendDueWebhooks(deps: SenderDeps, options: SendOptions = {}): Promise<number> {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS
  const due = await deps.outbox.leaseDue(deps.clock.now(), { limit: options.limit ?? 50, leaseMs: timeoutMs + 30_000, perEndpoint: options.perEndpoint ?? 5 })
  const sent = await Promise.all(due.map((d) => sendOne(deps, d, timeoutMs)))
  return sent.filter(Boolean).length
}

async function sendOne(deps: SenderDeps, due: DueDelivery, timeoutMs: number): Promise<boolean> {
  const { tenant, eventId, endpointId } = due
  const start = deps.clock.now()
  const prepared = await deps.inTenant(tenant, async (store) => {
    const delivery = await store.pendingDelivery(tenant, eventId, endpointId)
    if (!delivery) return null
    const secrets = delivery.url === null ? [] : await signingSecrets(store, deps.sealer, tenant, start)
    return { delivery, secrets }
  })
  if (!prepared) return false
  const { delivery, secrets } = prepared
  const number = delivery.attempts + 1
  const record = (attempt: Omit<RecordedAttempt, 'number'>) => deps.inTenant(tenant, (store) => store.recordAttempt(tenant, eventId, endpointId, { number, ...attempt }))

  if (delivery.url === null || secrets.length === 0) {
    const error = delivery.url === null ? 'endpoint_removed' : 'no_signing_secret'
    await record({ at: start, status: null, durationMs: 0, delivered: false, error, nextAt: null })
    return true
  }

  const headers = {
    'content-type': 'application/json',
    ...signatureHeaders(secrets, { id: eventId, timestampSeconds: Math.floor(start.getTime() / 1000), body: delivery.body }),
  }
  let result: PostResult
  try {
    result = await deps.post(delivery.url, { headers, body: delivery.body }, timeoutMs)
  } catch (err) {
    result = { status: null, error: err instanceof Error ? err.message : String(err) }
  }
  const end = deps.clock.now()
  const durationMs = Math.max(0, end.getTime() - start.getTime())
  const delivered = isDelivered({ status: result.status, durationMs })
  await record({
    at: start,
    status: result.status,
    durationMs,
    delivered,
    error: result.error ?? null,
    nextAt: delivered ? null : nextAttemptAt(number, end),
  })
  return true
}
