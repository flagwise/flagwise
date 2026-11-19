// The ReportStore on Postgres, and the flagging transaction runner. The store works inside a tenant
// transaction, so row-level security limits it to that tenant; every query also filters by the
// tenant it is given.

import type { TenantRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfRef, withTenant, type Database, type EventBus, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import type { FlaggingDeps, Report, ReportStore } from '../app/reports.ts'
import { reportsTable as t } from './schema.ts'

// Internal ids keep the service's first name: the migration set and the schema are 'intake'.
export const flaggingMigrations: MigrationSet = loadMigrations('intake', new URL('./migrations/', import.meta.url))

/** A ReportStore on the given tenant transaction. Reports read back equal the reports written. */
export function pgReportStore(tx: TenantTx): ReportStore {
  const tenantOf = (tenant: TenantRef) => and(eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode))
  const toReport = (r: typeof t.$inferSelect): Report => ({
    id: r.id,
    tenant: { appId: r.appId, livemode: r.livemode },
    reporterExternalId: r.reporterExternalId,
    reportedExternalId: r.reportedExternalId,
    category: r.category,
    snapshotKey: r.snapshotKey,
    idempotencyKey: r.idempotencyKey,
    requestHash: r.requestHash,
    receivedAt: r.receivedAt,
    caseId: r.caseId,
    joinedExistingCase: r.joinedExistingCase,
    ...(r.erasedAt && { erasedAt: r.erasedAt }),
  })

  return {
    async findById(tenant, reportId) {
      const [row] = await tx.select().from(t).where(and(tenantOf(tenant), eq(t.id, reportId)))
      return row ? toReport(row) : null
    },

    async findByIdempotencyKey(tenant, key, since) {
      const [row] = await tx.select().from(t).where(and(tenantOf(tenant), eq(t.idempotencyKey, key), gte(t.receivedAt, since)))
      return row ? toReport(row) : null
    },

    async insert(r, since) {
      if (r.idempotencyKey !== null) {
        await tx
          .update(t)
          .set({ idempotencyKey: null })
          .where(and(tenantOf(r.tenant), eq(t.idempotencyKey, r.idempotencyKey), lt(t.receivedAt, since)))
      }
      const inserted = await tx
        .insert(t)
        .values({
          appId: r.tenant.appId,
          livemode: r.tenant.livemode,
          id: r.id,
          reporterExternalId: r.reporterExternalId,
          reportedExternalId: r.reportedExternalId,
          category: r.category,
          snapshotKey: r.snapshotKey,
          idempotencyKey: r.idempotencyKey,
          requestHash: r.requestHash,
          receivedAt: r.receivedAt,
          caseId: r.caseId,
          joinedExistingCase: r.joinedExistingCase,
        })
        // Only the idempotency key can clash: report ids are new.
        .onConflictDoNothing({ target: [t.appId, t.livemode, t.idempotencyKey] })
        .returning({ id: t.id })
      return inserted.length === 1
    },

    async reportsOf(tenant, externalId) {
      const rows = await tx
        .select()
        .from(t)
        .where(and(tenantOf(tenant), or(eq(t.reporterExternalId, externalId), eq(t.reportedExternalId, externalId))))
      return rows.map(toReport)
    },

    async eraseAccount(tenant, externalId, erasedId, at) {
      const changed = await tx
        .update(t)
        .set({
          reporterExternalId: sql`CASE WHEN ${t.reporterExternalId} = ${externalId} THEN ${erasedId} ELSE ${t.reporterExternalId} END`,
          reportedExternalId: sql`CASE WHEN ${t.reportedExternalId} = ${externalId} THEN ${erasedId} ELSE ${t.reportedExternalId} END`,
          erasedAt: sql`COALESCE(${t.erasedAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(and(tenantOf(tenant), or(eq(t.reporterExternalId, externalId), eq(t.reportedExternalId, externalId))))
        .returning({ id: t.id })
      return changed.length
    },

    async setCase(tenant, reportId, caseId, joinedExistingCase) {
      const changed = await tx
        .update(t)
        .set({ caseId, joinedExistingCase })
        .where(and(tenantOf(tenant), eq(t.id, reportId), isNull(t.caseId)))
        .returning({ id: t.id })
      return changed.length === 1
    },
  }
}

/**
 * Runs flagging work in one tenant transaction on Postgres: the report store, and events written to
 * the bus in the same transaction with the tenant on them.
 */
export function pgFlaggingRunner(db: Database, bus: EventBus): FlaggingDeps['run'] {
  return (tenant, fn) =>
    withTenant(db, scopeOfRef(tenant), (tx) =>
      fn({
        reports: pgReportStore(tx),
        publish: async (event) => {
          await bus.publish({ ...event, tenant }, tx)
        },
      }),
    )
}
