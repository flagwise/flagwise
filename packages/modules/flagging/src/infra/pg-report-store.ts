// The ReportStore on Postgres, and the flagging transaction runner. The store works inside a tenant
// transaction, so row-level security limits it to that app; every query also filters by the
// tenant it is given.

import type { AppRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfApp, withApps, type Database, type EventBus, type MigrationSet, type AppTx } from '@flagwise/platform'
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import type { FlaggingDeps, Report, ReportStore } from '../app/reports.ts'
import { reportsTable as t } from './schema.ts'

// Internal ids keep the service's first name: the migration set and the schema are 'intake'.
export const flaggingMigrations: MigrationSet = loadMigrations('intake', new URL('./migrations/', import.meta.url))

/** A ReportStore on the given app transaction. Reports read back equal the reports written. */
export function pgReportStore(tx: AppTx): ReportStore {
  const appOf = (appRef: AppRef) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode))
  const toReport = (r: typeof t.$inferSelect): Report => ({
    id: r.id,
    appRef: { appId: r.appId, livemode: r.livemode },
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
    async findById(appRef, reportId) {
      const [row] = await tx.select().from(t).where(and(appOf(appRef), eq(t.id, reportId)))
      return row ? toReport(row) : null
    },

    async findByIdempotencyKey(appRef, key, since) {
      const [row] = await tx.select().from(t).where(and(appOf(appRef), eq(t.idempotencyKey, key), gte(t.receivedAt, since)))
      return row ? toReport(row) : null
    },

    async insert(r, since) {
      if (r.idempotencyKey !== null) {
        await tx
          .update(t)
          .set({ idempotencyKey: null })
          .where(and(appOf(r.appRef), eq(t.idempotencyKey, r.idempotencyKey), lt(t.receivedAt, since)))
      }
      const inserted = await tx
        .insert(t)
        .values({
          appId: r.appRef.appId,
          livemode: r.appRef.livemode,
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

    async reportsOf(appRef, externalId) {
      const rows = await tx
        .select()
        .from(t)
        .where(and(appOf(appRef), or(eq(t.reporterExternalId, externalId), eq(t.reportedExternalId, externalId))))
      return rows.map(toReport)
    },

    async eraseAccount(appRef, externalId, erasedId, at) {
      const changed = await tx
        .update(t)
        .set({
          reporterExternalId: sql`CASE WHEN ${t.reporterExternalId} = ${externalId} THEN ${erasedId} ELSE ${t.reporterExternalId} END`,
          reportedExternalId: sql`CASE WHEN ${t.reportedExternalId} = ${externalId} THEN ${erasedId} ELSE ${t.reportedExternalId} END`,
          erasedAt: sql`COALESCE(${t.erasedAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(and(appOf(appRef), or(eq(t.reporterExternalId, externalId), eq(t.reportedExternalId, externalId))))
        .returning({ id: t.id })
      return changed.length
    },

    async setCase(appRef, reportId, caseId, joinedExistingCase) {
      const changed = await tx
        .update(t)
        .set({ caseId, joinedExistingCase })
        .where(and(appOf(appRef), eq(t.id, reportId), isNull(t.caseId)))
        .returning({ id: t.id })
      return changed.length === 1
    },
  }
}

/**
 * Runs flagging work in one app transaction on Postgres: the report store, and events written to
 * the bus in the same transaction with the app on them.
 */
export function pgFlaggingRunner(db: Database, bus: EventBus): FlaggingDeps['run'] {
  return (appRef, fn) =>
    withApps(db, scopeOfApp(appRef), (tx) =>
      fn({
        reports: pgReportStore(tx),
        publish: async (event) => {
          await bus.publish({ ...event, appRef }, tx)
        },
      }),
    )
}
