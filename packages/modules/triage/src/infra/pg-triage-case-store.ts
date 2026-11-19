// Triage's record of each case on Postgres, and triage's deps on a database and bus. The store
// works inside an app transaction; every query also filters by the app it is given.

import type { AppRef } from '@flagwise/kernel'
import { pgUnitOfWork, type Database, type EventBus, type AppTx } from '@flagwise/platform'
import { and, eq, or, sql } from 'drizzle-orm'
import type { ReportAccounts, TriageCase, TriageCaseStore, TriageClassification, TriageDeps } from '../app/ports.ts'
import { pgTriagePolicyCopy } from './pg-policy-copy.ts'
import { triageCasesTable as t } from './schema.ts'

interface StoredAccounts {
  readonly reportId: string
  readonly reporterExternalId: string
  readonly reporterAccountCreatedAt: string | null
  readonly reportedAccountCreatedAt: string | null
}

const stored = (r: ReportAccounts): StoredAccounts => ({
  reportId: r.reportId,
  reporterExternalId: r.reporterExternalId,
  reporterAccountCreatedAt: r.reporterAccountCreatedAt?.toISOString() ?? null,
  reportedAccountCreatedAt: r.reportedAccountCreatedAt?.toISOString() ?? null,
})
const time = (v: string | null) => (v === null ? null : new Date(v))

export function pgTriageCaseStore(tx: AppTx): TriageCaseStore {
  const one = (appRef: AppRef, caseId: string) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode), eq(t.caseId, caseId))
  return {
    async find(appRef, caseId) {
      const [row] = await tx.select().from(t).where(one(appRef, caseId))
      if (!row) return null
      return {
        appRef,
        caseId,
        ...(row.subjectExternalId !== null && { subjectExternalId: row.subjectExternalId }),
        openedAt: row.openedAt,
        reportIds: row.reportIds,
        reports: (row.reports as StoredAccounts[]).map((r) => ({ ...r, reporterAccountCreatedAt: time(r.reporterAccountCreatedAt), reportedAccountCreatedAt: time(r.reportedAccountCreatedAt) })),
        state: row.state as TriageCase['state'],
        classification: (row.classification as TriageClassification | null) ?? null,
        claimed: row.claimed,
        everClaimed: row.everClaimed,
        corrected: row.corrected,
        decided: row.decided,
      }
    },

    async open(r) {
      await tx
        .insert(t)
        .values({
          appId: r.appRef.appId,
          livemode: r.appRef.livemode,
          caseId: r.caseId,
          subjectExternalId: r.subjectExternalId ?? null,
          openedAt: r.openedAt,
          reportIds: [...r.reportIds],
          reports: r.reports.map(stored),
          state: r.state,
          classification: r.classification,
          claimed: r.claimed,
          everClaimed: r.everClaimed,
          corrected: r.corrected,
          decided: r.decided,
        })
        .onConflictDoNothing()
    },

    async eraseAccount(appRef, externalId, erasedId) {
      const rows = await tx
        .select({ caseId: t.caseId, subject: t.subjectExternalId, reports: t.reports })
        .from(t)
        .where(
          and(
            
            eq(t.appId, appRef.appId),
            eq(t.livemode, appRef.livemode),
            or(eq(t.subjectExternalId, externalId), sql`${t.reports} @> ${JSON.stringify([{ reporterExternalId: externalId }])}::jsonb`),
          ),
        )
        .for('update')
      for (const row of rows) {
        const reported = row.subject === externalId
        const reports = (row.reports as StoredAccounts[]).map((r) => ({
          ...r,
          ...(r.reporterExternalId === externalId && { reporterExternalId: erasedId, reporterAccountCreatedAt: null }),
          ...(reported && { reportedAccountCreatedAt: null }),
        }))
        await tx
          .update(t)
          .set({ reports, ...(reported && { subjectExternalId: erasedId }) })
          .where(one(appRef, row.caseId))
      }
      return rows.length
    },

    async attach(appRef, caseId, reportId, facts) {
      const [row] = await tx.select({ reportIds: t.reportIds, reports: t.reports }).from(t).where(one(appRef, caseId)).for('update')
      if (!row) return false
      if (row.reportIds.includes(reportId)) return true
      const reports = row.reports as StoredAccounts[]
      await tx
        .update(t)
        .set({ reportIds: [...row.reportIds, reportId], reports: facts ? [...reports, stored({ reportId, ...facts })] : reports })
        .where(one(appRef, caseId))
      return true
    },

    async change(appRef, caseId, change) {
      const set = Object.keys(change).length > 0 ? change : { caseId }
      const rows = await tx.update(t).set(set).where(one(appRef, caseId)).returning({ caseId: t.caseId })
      return rows.length > 0
    },
  }
}

/** Triage on Postgres: its record of each case and its policy copy, each run in its own app transaction. */
export function pgTriageDeps(db: Database, bus: EventBus): TriageDeps {
  return { uow: pgUnitOfWork(db, bus, (tx) => ({ cases: pgTriageCaseStore(tx) })), policy: pgTriagePolicyCopy(db) }
}
