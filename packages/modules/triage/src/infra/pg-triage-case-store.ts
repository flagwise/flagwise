// Triage's record of each case on Postgres, and triage's deps on a database and bus. The store
// works inside a tenant transaction; every query also filters by the tenant it is given.

import type { TenantRef } from '@flagwise/kernel'
import { pgUnitOfWork, type Database, type EventBus, type TenantTx } from '@flagwise/platform'
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

export function pgTriageCaseStore(tx: TenantTx): TriageCaseStore {
  const one = (tenant: TenantRef, caseId: string) => and(eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode), eq(t.caseId, caseId))
  return {
    async find(tenant, caseId) {
      const [row] = await tx.select().from(t).where(one(tenant, caseId))
      if (!row) return null
      return {
        tenant,
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
          appId: r.tenant.appId,
          livemode: r.tenant.livemode,
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

    async eraseAccount(tenant, externalId, erasedId) {
      const rows = await tx
        .select({ caseId: t.caseId, subject: t.subjectExternalId, reports: t.reports })
        .from(t)
        .where(
          and(
            
            eq(t.appId, tenant.appId),
            eq(t.livemode, tenant.livemode),
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
          .where(one(tenant, row.caseId))
      }
      return rows.length
    },

    async attach(tenant, caseId, reportId, facts) {
      const [row] = await tx.select({ reportIds: t.reportIds, reports: t.reports }).from(t).where(one(tenant, caseId)).for('update')
      if (!row) return false
      if (row.reportIds.includes(reportId)) return true
      const reports = row.reports as StoredAccounts[]
      await tx
        .update(t)
        .set({ reportIds: [...row.reportIds, reportId], reports: facts ? [...reports, stored({ reportId, ...facts })] : reports })
        .where(one(tenant, caseId))
      return true
    },

    async change(tenant, caseId, change) {
      const set = Object.keys(change).length > 0 ? change : { caseId }
      const rows = await tx.update(t).set(set).where(one(tenant, caseId)).returning({ caseId: t.caseId })
      return rows.length > 0
    },
  }
}

/** Triage on Postgres: its record of each case and its policy copy, each run in its own tenant transaction. */
export function pgTriageDeps(db: Database, bus: EventBus): TriageDeps {
  return { uow: pgUnitOfWork(db, bus, (tx) => ({ cases: pgTriageCaseStore(tx) })), policy: pgTriagePolicyCopy(db) }
}
