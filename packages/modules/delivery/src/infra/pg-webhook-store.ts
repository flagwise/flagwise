// The webhook tables on Postgres: the app-scoped store (secrets, endpoints, events, deliveries and
// attempts), the outbox the sender leases due deliveries from as the system role, and resealing
// every secret under a new master key.

import type { AppRef } from '@flagwise/kernel'
import type { SystemTx, AppTx } from '@flagwise/platform'
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { DueDelivery, SendStore, WebhookOutbox } from '../app/send-webhooks.ts'
import { secretContext, type SecretSealer, type StoredSecret, type WebhookEndpoint, type WebhookEventType, type WebhookStore } from '../app/webhooks.ts'
import {
  webhookAttemptsTable as attempts,
  webhookDeliveriesTable as deliveries,
  webhookEndpointsTable as endpoints,
  webhookEventsTable as events,
  webhookSecretsTable as secrets,
} from './schema.ts'

interface AppColumns {
  readonly appId: AnyPgColumn
  readonly livemode: AnyPgColumn
}
const columnsOf = (appRef: AppRef) => ({ appId: appRef.appId, livemode: appRef.livemode })

/** A WebhookStore and SendStore on an app transaction; every query also filters by the app it is given. */
export function pgWebhookStore(tx: AppTx): WebhookStore & SendStore {
  const appOf = (t: AppColumns, appRef: AppRef) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode))

  return {
    async lockApp(appRef) {
      const key = JSON.stringify([appRef.appId, appRef.livemode])
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery.webhooks:${key}`}, 0))`)
    },

    async secrets(appRef) {
      const rows = await tx.select().from(secrets).where(appOf(secrets, appRef)).orderBy(desc(secrets.version))
      return rows.map((r): StoredSecret => ({ version: r.version, sealed: r.sealed, createdAt: r.createdAt, expiresAt: r.expiresAt }))
    },

    async insertSecret(appRef, s) {
      await tx.insert(secrets).values({ ...columnsOf(appRef), version: s.version, sealed: s.sealed, createdAt: s.createdAt, expiresAt: s.expiresAt })
    },

    async expireSecretsBy(appRef, at) {
      await tx
        .update(secrets)
        .set({ expiresAt: at })
        .where(and(appOf(secrets, appRef), or(isNull(secrets.expiresAt), gt(secrets.expiresAt, at))))
    },

    async endpoints(appRef) {
      const rows = await tx.select().from(endpoints).where(appOf(endpoints, appRef)).orderBy(asc(endpoints.createdAt), asc(endpoints.id))
      return rows.map(
        (r): WebhookEndpoint => ({
          id: r.id,
          appRef: { appId: r.appId, livemode: r.livemode },
          url: r.url,
          eventTypes: (r.eventTypes as WebhookEventType[] | null) ?? null,
          createdAt: r.createdAt,
        }),
      )
    },

    async insertEndpoint(e) {
      await tx.insert(endpoints).values({ ...columnsOf(e.appRef), id: e.id, url: e.url, eventTypes: e.eventTypes ? [...e.eventTypes] : null, createdAt: e.createdAt })
    },

    async deleteEndpoint(appRef, id, now) {
      const removed = await tx.delete(endpoints).where(and(appOf(endpoints, appRef), eq(endpoints.id, id))).returning({ id: endpoints.id })
      if (removed.length === 0) return false
      await tx
        .update(deliveries)
        .set({ status: 'failed', nextAttemptAt: null, leasedUntil: null, finishedAt: now })
        .where(and(appOf(deliveries, appRef), eq(deliveries.endpointId, id), eq(deliveries.status, 'pending')))
      return true
    },

    async eraseAccount(appRef, externalId, erasedId) {
      const changed = await tx
        .update(events)
        .set({ body: sql`jsonb_set(${events.body}::jsonb, '{data,subject_external_id}', to_jsonb(${erasedId}::text))::text` })
        .where(and(appOf(events, appRef), sql`${events.body}::jsonb #>> '{data,subject_external_id}' = ${externalId}`))
        .returning({ id: events.id })
      return changed.length
    },

    async insertEvent(appRef, e) {
      await tx
        .insert(events)
        .values({ ...columnsOf(appRef), id: e.id, sourceId: e.sourceId, type: e.type, body: e.body, createdAt: e.createdAt })
        .onConflictDoNothing({ target: [events.appId, events.livemode, events.sourceId] })
      const [row] = await tx.select().from(events).where(and(appOf(events, appRef), eq(events.sourceId, e.sourceId)))
      return { id: row!.id, sourceId: row!.sourceId, type: row!.type, body: row!.body, createdAt: row!.createdAt }
    },

    async insertDelivery(appRef, d) {
      await tx
        .insert(deliveries)
        .values({ ...columnsOf(appRef), eventId: d.eventId, endpointId: d.endpointId, status: 'pending', attempts: 0, nextAttemptAt: d.dueAt, createdAt: d.createdAt })
        .onConflictDoNothing()
    },

    async pendingDelivery(appRef, eventId, endpointId) {
      const [row] = await tx
        .select({ attempts: deliveries.attempts, body: events.body, url: endpoints.url })
        .from(deliveries)
        .innerJoin(events, and(eq(events.appId, deliveries.appId), eq(events.id, deliveries.eventId)))
        .leftJoin(endpoints, and(eq(endpoints.appId, deliveries.appId), eq(endpoints.livemode, deliveries.livemode), eq(endpoints.id, deliveries.endpointId)))
        .where(and(appOf(deliveries, appRef), eq(deliveries.eventId, eventId), eq(deliveries.endpointId, endpointId), eq(deliveries.status, 'pending')))
      return row ? { attempts: row.attempts, body: row.body, url: row.url ?? null } : null
    },

    async recordAttempt(appRef, eventId, endpointId, a) {
      const status = a.delivered ? 'delivered' : a.nextAt === null ? 'failed' : 'pending'
      const moved = await tx
        .update(deliveries)
        .set({ status, attempts: a.number, nextAttemptAt: status === 'pending' ? a.nextAt : null, leasedUntil: null, finishedAt: status === 'pending' ? null : a.at })
        .where(and(appOf(deliveries, appRef), eq(deliveries.eventId, eventId), eq(deliveries.endpointId, endpointId), eq(deliveries.attempts, a.number - 1), eq(deliveries.status, 'pending')))
        .returning({ eventId: deliveries.eventId })
      if (moved.length === 0) return
      await tx.insert(attempts).values({
        ...columnsOf(appRef),
        eventId,
        endpointId,
        number: a.number,
        at: a.at,
        status: a.status,
        durationMs: a.durationMs,
        delivered: a.delivered,
        error: a.error,
      })
    },
  }
}

/** The WebhookOutbox on the system role, which may see and lease deliveries of every app. */
export function pgWebhookOutbox(tx: SystemTx): WebhookOutbox {
  return {
    async leaseDue(now, { limit, leaseMs, perEndpoint }) {
      const until = new Date(now.getTime() + leaseMs)
      // Candidates per endpoint in due order, minus what that endpoint already has leased; locked
      // rows another sender is leasing right now are skipped.
      const result = await tx.execute(sql`
        WITH held AS (
          SELECT app_id, endpoint_id, count(*) AS n FROM delivery.webhook_deliveries
          WHERE status = 'pending' AND leased_until > ${now}
          GROUP BY app_id, endpoint_id
        ),
        free AS (
          SELECT d.app_id, d.livemode, d.event_id, d.endpoint_id, d.next_attempt_at FROM delivery.webhook_deliveries d
          WHERE d.status = 'pending' AND d.next_attempt_at <= ${now} AND (d.leased_until IS NULL OR d.leased_until <= ${now})
          ORDER BY d.next_attempt_at
          LIMIT ${limit * 4}
          FOR UPDATE SKIP LOCKED
        ),
        ranked AS (
          SELECT f.*, row_number() OVER (PARTITION BY f.app_id, f.endpoint_id ORDER BY f.next_attempt_at, f.event_id) AS rank,
                 coalesce(h.n, 0) AS held
          FROM free f LEFT JOIN held h USING (app_id, endpoint_id)
        ),
        picked AS (
          SELECT app_id, event_id, endpoint_id FROM ranked WHERE rank + held <= ${perEndpoint}
          ORDER BY next_attempt_at LIMIT ${limit}
        )
        UPDATE delivery.webhook_deliveries d SET leased_until = ${until}
        FROM picked p
        WHERE d.app_id = p.app_id AND d.event_id = p.event_id AND d.endpoint_id = p.endpoint_id
        RETURNING d.app_id, d.livemode, d.event_id, d.endpoint_id, d.next_attempt_at`)
      const rows = result.rows as { app_id: string; livemode: boolean; event_id: string; endpoint_id: string; next_attempt_at: Date | string }[]
      return rows
        .sort((a, b) => new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime())
        .map((r): DueDelivery => ({ appRef: { appId: r.app_id, livemode: r.livemode }, eventId: r.event_id, endpointId: r.endpoint_id }))
    },
  }
}

/**
 * Reseals every app's signing secrets with the keyring's current key, as the system role, in one
 * transaction; `open` and `seal` come from a keyring that still has the old keys. Values already
 * sealed with the current key are left alone. Returns how many it resealed.
 */
export async function resealWebhookSecrets(tx: SystemTx, sealer: SecretSealer & { readonly currentKeyId: string; keyIdOf(sealed: string): string }): Promise<number> {
  const rows = await tx.select().from(secrets)
  let n = 0
  for (const r of rows) {
    if (sealer.keyIdOf(r.sealed) === sealer.currentKeyId) continue
    const context = secretContext({ appId: r.appId, livemode: r.livemode }, r.version)
    const resealed = sealer.seal(sealer.open(r.sealed, context), context)
    await tx
      .update(secrets)
      .set({ sealed: resealed })
      .where(and(eq(secrets.appId, r.appId), eq(secrets.livemode, r.livemode), eq(secrets.version, r.version)))
    n++
  }
  return n
}
