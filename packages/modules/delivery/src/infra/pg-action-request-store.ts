// The ActionRequestStore on Postgres. It works inside an app transaction, so row-level security
// limits it to that app; every query also filters by the app it is given.

import type { AppRef } from '@flagwise/kernel'
import { loadMigrations, type MigrationSet, type AppTx } from '@flagwise/platform'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { ActionRequest, ActionRequestStore } from '../app/action-requests.ts'
import { actionRequestsTable as t } from './schema.ts'

export const deliveryMigrations: MigrationSet = loadMigrations('delivery', new URL('./migrations/', import.meta.url))

/**
 * An ActionRequestStore on the given app transaction. Requests read back equal the requests
 * written. `insert` places a request after the decision's existing ones; `update` saves status,
 * failReason and replacedBy only.
 */
export function pgActionRequestStore(tx: AppTx): ActionRequestStore {
  const appOf = (appRef: AppRef) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode))
  const toRequest = (r: typeof t.$inferSelect): ActionRequest => ({
    id: r.id,
    appRef: { appId: r.appId, livemode: r.livemode },
    caseId: r.caseId,
    decisionId: r.decisionId,
    actionKey: r.actionKey,
    status: r.status as ActionRequest['status'],
    failReason: r.failReason,
    retryId: r.retryId,
    replacedBy: r.replacedBy,
  })

  return {
    async findById(appRef, id) {
      const [row] = await tx.select().from(t).where(and(appOf(appRef), eq(t.id, id)))
      return row ? toRequest(row) : null
    },

    async findByDecision(appRef, decisionId) {
      const rows = await tx.select().from(t).where(and(appOf(appRef), eq(t.decisionId, decisionId))).orderBy(asc(t.position))
      return rows.map(toRequest)
    },

    async lockDecision(appRef, decisionId) {
      // A transaction-scoped advisory lock; a hash collision only makes two decisions wait for each other.
      const key = JSON.stringify([appRef.appId, appRef.livemode, decisionId])
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery.decision:${key}`}, 0))`)
    },

    async insert(r) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(appOf(r.appRef), eq(t.decisionId, r.decisionId)))
      await tx.insert(t).values({
        appId: r.appRef.appId,
        livemode: r.appRef.livemode,
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
        .where(and(appOf(r.appRef), eq(t.id, r.id)))
    },
  }
}
