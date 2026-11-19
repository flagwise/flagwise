// The ActionRequestStore on Postgres. It works inside a tenant transaction, so row-level security
// limits it to that tenant; every query also filters by the tenant it is given.

import type { TenantRef } from '@flagwise/kernel'
import { loadMigrations, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { ActionRequest, ActionRequestStore } from '../app/action-requests.ts'
import { actionRequestsTable as t } from './schema.ts'

export const deliveryMigrations: MigrationSet = loadMigrations('delivery', new URL('./migrations/', import.meta.url))

/**
 * An ActionRequestStore on the given tenant transaction. Requests read back equal the requests
 * written. `insert` places a request after the decision's existing ones; `update` saves status,
 * failReason and replacedBy only.
 */
export function pgActionRequestStore(tx: TenantTx): ActionRequestStore {
  const tenantOf = (tenant: TenantRef) => and(eq(t.orgId, tenant.orgId), eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode))
  const toRequest = (r: typeof t.$inferSelect): ActionRequest => ({
    id: r.id,
    tenant: { orgId: r.orgId, appId: r.appId, livemode: r.livemode },
    caseId: r.caseId,
    decisionId: r.decisionId,
    actionKey: r.actionKey,
    status: r.status as ActionRequest['status'],
    failReason: r.failReason,
    retryId: r.retryId,
    replacedBy: r.replacedBy,
  })

  return {
    async findById(tenant, id) {
      const [row] = await tx.select().from(t).where(and(tenantOf(tenant), eq(t.id, id)))
      return row ? toRequest(row) : null
    },

    async findByDecision(tenant, decisionId) {
      const rows = await tx.select().from(t).where(and(tenantOf(tenant), eq(t.decisionId, decisionId))).orderBy(asc(t.position))
      return rows.map(toRequest)
    },

    async lockDecision(tenant, decisionId) {
      // A transaction-scoped advisory lock; a hash collision only makes two decisions wait for each other.
      const key = JSON.stringify([tenant.orgId, tenant.appId, tenant.livemode, decisionId])
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery.decision:${key}`}, 0))`)
    },

    async insert(r) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(tenantOf(r.tenant), eq(t.decisionId, r.decisionId)))
      await tx.insert(t).values({
        orgId: r.tenant.orgId,
        appId: r.tenant.appId,
        livemode: r.tenant.livemode,
        id: r.id,
        caseId: r.caseId,
        decisionId: r.decisionId,
        position: n,
        actionKey: r.actionKey,
        status: r.status,
        failReason: r.failReason,
        retryId: r.retryId,
        replacedBy: r.replacedBy,
      })
    },

    async update(r) {
      await tx
        .update(t)
        .set({ status: r.status, failReason: r.failReason, replacedBy: r.replacedBy })
        .where(and(tenantOf(r.tenant), eq(t.id, r.id)))
    },
  }
}
