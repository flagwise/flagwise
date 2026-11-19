// The webhook tables on Postgres: the tenant store (secrets, endpoints, events, deliveries and
// attempts), the outbox the sender leases due deliveries from as the system role, and resealing
// every secret under a new master key.

import type { TenantRef } from '@flagwise/kernel'
import type { SystemTx, TenantTx } from '@flagwise/platform'
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

interface TenantColumns {
  readonly orgId: AnyPgColumn
  readonly appId: AnyPgColumn
  readonly livemode: AnyPgColumn
}
const columnsOf = (tenant: TenantRef) => ({ orgId: tenant.orgId, appId: tenant.appId, livemode: tenant.livemode })

/** A WebhookStore and SendStore on a tenant transaction; every query also filters by the tenant it is given. */
export function pgWebhookStore(tx: TenantTx): WebhookStore & SendStore {
  const tenantOf = (t: TenantColumns, tenant: TenantRef) => and(eq(t.orgId, tenant.orgId), eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode))

  return {
    async lockApp(tenant) {
      const key = JSON.stringify([tenant.orgId, tenant.appId, tenant.livemode])
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery.webhooks:${key}`}, 0))`)
    },

    async secrets(tenant) {
      const rows = await tx.select().from(secrets).where(tenantOf(secrets, tenant)).orderBy(desc(secrets.version))
      return rows.map((r): StoredSecret => ({ version: r.version, sealed: r.sealed, createdAt: r.createdAt, expiresAt: r.expiresAt }))
    },

    async insertSecret(tenant, s) {
      await tx.insert(secrets).values({ ...columnsOf(tenant), version: s.version, sealed: s.sealed, createdAt: s.createdAt, expiresAt: s.expiresAt })
    },

    async expireSecretsBy(tenant, at) {
      await tx
        .update(secrets)
        .set({ expiresAt: at })
        .where(and(tenantOf(secrets, tenant), or(isNull(secrets.expiresAt), gt(secrets.expiresAt, at))))
    },

    async endpoints(tenant) {
      const rows = await tx.select().from(endpoints).where(tenantOf(endpoints, tenant)).orderBy(asc(endpoints.createdAt), asc(endpoints.id))
      return rows.map(
        (r): WebhookEndpoint => ({
          id: r.id,
          tenant: { orgId: r.orgId, appId: r.appId, livemode: r.livemode },
          url: r.url,
          eventTypes: (r.eventTypes as WebhookEventType[] | null) ?? null,
          createdAt: r.createdAt,
        }),
      )
    },

    async insertEndpoint(e) {
      await tx.insert(endpoints).values({ ...columnsOf(e.tenant), id: e.id, url: e.url, eventTypes: e.eventTypes ? [...e.eventTypes] : null, createdAt: e.createdAt })
    },

    async deleteEndpoint(tenant, id, now) {
      const removed = await tx.delete(endpoints).where(and(tenantOf(endpoints, tenant), eq(endpoints.id, id))).returning({ id: endpoints.id })
      if (removed.length === 0) return false
      await tx
        .update(deliveries)
        .set({ status: 'failed', nextAttemptAt: null, leasedUntil: null, finishedAt: now })
        .where(and(tenantOf(deliveries, tenant), eq(deliveries.endpointId, id), eq(deliveries.status, 'pending')))
      return true
    },

    async insertEvent(tenant, e) {
      await tx
        .insert(events)
        .values({ ...columnsOf(tenant), id: e.id, sourceId: e.sourceId, type: e.type, body: e.body, createdAt: e.createdAt })
        .onConflictDoNothing({ target: [events.orgId, events.appId, events.livemode, events.sourceId] })
      const [row] = await tx.select().from(events).where(and(tenantOf(events, tenant), eq(events.sourceId, e.sourceId)))
      return { id: row!.id, sourceId: row!.sourceId, type: row!.type, body: row!.body, createdAt: row!.createdAt }
    },

    async insertDelivery(tenant, d) {
      await tx
        .insert(deliveries)
        .values({ ...columnsOf(tenant), eventId: d.eventId, endpointId: d.endpointId, status: 'pending', attempts: 0, nextAttemptAt: d.dueAt, createdAt: d.createdAt })
        .onConflictDoNothing()
    },

    async pendingDelivery(tenant, eventId, endpointId) {
      const [row] = await tx
        .select({ attempts: deliveries.attempts, body: events.body, url: endpoints.url })
        .from(deliveries)
        .innerJoin(events, and(eq(events.orgId, deliveries.orgId), eq(events.appId, deliveries.appId), eq(events.id, deliveries.eventId)))
        .leftJoin(endpoints, and(eq(endpoints.orgId, deliveries.orgId), eq(endpoints.appId, deliveries.appId), eq(endpoints.livemode, deliveries.livemode), eq(endpoints.id, deliveries.endpointId)))
        .where(and(tenantOf(deliveries, tenant), eq(deliveries.eventId, eventId), eq(deliveries.endpointId, endpointId), eq(deliveries.status, 'pending')))
      return row ? { attempts: row.attempts, body: row.body, url: row.url ?? null } : null
    },

    async recordAttempt(tenant, eventId, endpointId, a) {
      const status = a.delivered ? 'delivered' : a.nextAt === null ? 'failed' : 'pending'
      const moved = await tx
        .update(deliveries)
        .set({ status, attempts: a.number, nextAttemptAt: status === 'pending' ? a.nextAt : null, leasedUntil: null, finishedAt: status === 'pending' ? null : a.at })
        .where(and(tenantOf(deliveries, tenant), eq(deliveries.eventId, eventId), eq(deliveries.endpointId, endpointId), eq(deliveries.attempts, a.number - 1), eq(deliveries.status, 'pending')))
        .returning({ eventId: deliveries.eventId })
      if (moved.length === 0) return
      await tx.insert(attempts).values({
        ...columnsOf(tenant),
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

/** The WebhookOutbox on the system role, which may see and lease deliveries of every tenant. */
export function pgWebhookOutbox(tx: SystemTx): WebhookOutbox {
  return {
    async leaseDue(now, { limit, leaseMs, perEndpoint }) {
      const until = new Date(now.getTime() + leaseMs)
      // Candidates per endpoint in due order, minus what that endpoint already has leased; locked
      // rows another sender is leasing right now are skipped.
      const result = await tx.execute(sql`
        WITH held AS (
          SELECT org_id, app_id, endpoint_id, count(*) AS n FROM delivery.webhook_deliveries
          WHERE status = 'pending' AND leased_until > ${now}
          GROUP BY org_id, app_id, endpoint_id
        ),
        free AS (
          SELECT d.org_id, d.app_id, d.livemode, d.event_id, d.endpoint_id, d.next_attempt_at FROM delivery.webhook_deliveries d
          WHERE d.status = 'pending' AND d.next_attempt_at <= ${now} AND (d.leased_until IS NULL OR d.leased_until <= ${now})
          ORDER BY d.next_attempt_at
          LIMIT ${limit * 4}
          FOR UPDATE SKIP LOCKED
        ),
        ranked AS (
          SELECT f.*, row_number() OVER (PARTITION BY f.org_id, f.app_id, f.endpoint_id ORDER BY f.next_attempt_at, f.event_id) AS rank,
                 coalesce(h.n, 0) AS held
          FROM free f LEFT JOIN held h USING (org_id, app_id, endpoint_id)
        ),
        picked AS (
          SELECT org_id, app_id, event_id, endpoint_id FROM ranked WHERE rank + held <= ${perEndpoint}
          ORDER BY next_attempt_at LIMIT ${limit}
        )
        UPDATE delivery.webhook_deliveries d SET leased_until = ${until}
        FROM picked p
        WHERE d.org_id = p.org_id AND d.app_id = p.app_id AND d.event_id = p.event_id AND d.endpoint_id = p.endpoint_id
        RETURNING d.org_id, d.app_id, d.livemode, d.event_id, d.endpoint_id, d.next_attempt_at`)
      const rows = result.rows as { org_id: string; app_id: string; livemode: boolean; event_id: string; endpoint_id: string; next_attempt_at: Date | string }[]
      return rows
        .sort((a, b) => new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime())
        .map((r): DueDelivery => ({ tenant: { orgId: r.org_id, appId: r.app_id, livemode: r.livemode }, eventId: r.event_id, endpointId: r.endpoint_id }))
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
    const context = secretContext({ orgId: r.orgId, appId: r.appId, livemode: r.livemode }, r.version)
    const resealed = sealer.seal(sealer.open(r.sealed, context), context)
    await tx
      .update(secrets)
      .set({ sealed: resealed })
      .where(and(eq(secrets.orgId, r.orgId), eq(secrets.appId, r.appId), eq(secrets.livemode, r.livemode), eq(secrets.version, r.version)))
    n++
  }
  return n
}
