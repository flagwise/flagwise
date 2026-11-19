// The ClassificationStore on Postgres, and the classify transaction runner.

import type { TenantRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfRef, withTenant, type Database, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, count, eq, gte, inArray, or, sql } from 'drizzle-orm'
import type { ClassificationRecord, ClassificationStore, ClassifyDeps } from '../app/ports.ts'
import { reportScreeningsTable as rs, classificationsTable as t } from './schema.ts'

export const classifyMigrations: MigrationSet = loadMigrations('classify', new URL('./migrations/', import.meta.url))

/** A ClassificationStore on the given tenant transaction. Records read back equal the records written. */
export function pgClassificationStore(tx: TenantTx): ClassificationStore {
  const tenantOf = (tenant: TenantRef) => and(eq(t.orgId, tenant.orgId), eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode))

  return {
    async find(tenant, caseId) {
      const [r] = await tx.select().from(t).where(and(tenantOf(tenant), eq(t.caseId, caseId)))
      if (!r) return null
      return {
        tenant: { orgId: r.orgId, appId: r.appId, livemode: r.livemode },
        caseId: r.caseId,
        reportId: r.reportId,
        categoryId: r.categoryId,
        customCategoryId: r.customCategoryId,
        confidence: r.confidence,
        signals: r.signals,
        summary: r.summary,
        injectionSuspected: r.injectionSuspected,
        preRuleP0: r.preRuleP0,
        classifiedBy: r.classifiedBy,
        rulesReason: r.rulesReason,
        model: r.model,
        promptHash: r.promptHash,
        escalated: r.escalated,
        escalationCapped: r.escalationCapped,
        lowConfidence: r.lowConfidence,
        usage: { input: r.inputTokens, output: r.outputTokens, cached: r.cachedTokens },
        classifiedAt: r.classifiedAt,
      } satisfies ClassificationRecord
    },

    async insert(c) {
      const inserted = await tx
        .insert(t)
        .values({ orgId: c.tenant.orgId, appId: c.tenant.appId, livemode: c.tenant.livemode, caseId: c.caseId, ...columns(c) })
        .onConflictDoNothing({ target: [t.orgId, t.appId, t.caseId] })
        .returning({ caseId: t.caseId })
      return inserted.length === 1
    },

    async replaceFailed(c) {
      const replaced = await tx
        .update(t)
        .set(columns(c))
        .where(and(tenantOf(c.tenant), eq(t.caseId, c.caseId), eq(t.classifiedBy, 'rules'), eq(t.rulesReason, 'llm_failed')))
        .returning({ caseId: t.caseId })
      return replaced.length === 1
    },

    async monthCounts(tenant, since) {
      const [row] = await tx
        .select({ cases: count(), escalations: sql`count(*) FILTER (WHERE ${t.escalated})`.mapWith(Number) })
        .from(t)
        .where(and(tenantOf(tenant), eq(t.classifiedBy, 'llm'), gte(t.classifiedAt, since)))
      return { cases: row?.cases ?? 0, escalations: row?.escalations ?? 0 }
    },

    async keepScreening(s) {
      await tx
        .insert(rs)
        .values({
          orgId: s.tenant.orgId,
          appId: s.tenant.appId,
          livemode: s.tenant.livemode,
          reportId: s.reportId,
          p0Signals: [...s.p0Signals],
          injectionSuspected: s.injectionSuspected,
          reportedExternalId: s.reportedExternalId ?? null,
          reporterExternalId: s.reporterExternalId ?? null,
        })
        .onConflictDoNothing()
    },

    async eraseAccount(tenant, externalId, erasedId) {
      const ofTenant = and(eq(rs.orgId, tenant.orgId), eq(rs.appId, tenant.appId), eq(rs.livemode, tenant.livemode))
      const reports = await tx
        .update(rs)
        .set({
          reportedExternalId: sql`CASE WHEN ${rs.reportedExternalId} = ${externalId} THEN ${erasedId} ELSE ${rs.reportedExternalId} END`,
          reporterExternalId: sql`CASE WHEN ${rs.reporterExternalId} = ${externalId} THEN ${erasedId} ELSE ${rs.reporterExternalId} END`,
        })
        .where(and(ofTenant, or(eq(rs.reportedExternalId, externalId), eq(rs.reporterExternalId, externalId))))
        .returning({ reportId: rs.reportId })
      if (reports.length > 0) {
        await tx
          .update(t)
          .set({ summary: null })
          .where(and(tenantOf(tenant), inArray(t.reportId, reports.map((r) => r.reportId))))
      }
      return reports.length
    },

    async findScreening(tenant, reportId) {
      const [r] = await tx
        .select()
        .from(rs)
        .where(and(eq(rs.orgId, tenant.orgId), eq(rs.appId, tenant.appId), eq(rs.livemode, tenant.livemode), eq(rs.reportId, reportId)))
      return r
        ? {
            tenant: { orgId: r.orgId, appId: r.appId, livemode: r.livemode },
            reportId: r.reportId,
            p0Signals: r.p0Signals,
            injectionSuspected: r.injectionSuspected,
            ...(r.reportedExternalId !== null && { reportedExternalId: r.reportedExternalId }),
            ...(r.reporterExternalId !== null && { reporterExternalId: r.reporterExternalId }),
          }
        : null
    },
  }
}

/** The columns of a record other than its tenant and case. */
const columns = (c: ClassificationRecord) => ({
  reportId: c.reportId,
  categoryId: c.categoryId,
  customCategoryId: c.customCategoryId,
  confidence: c.confidence,
  signals: [...c.signals],
  summary: c.summary,
  injectionSuspected: c.injectionSuspected,
  preRuleP0: c.preRuleP0,
  classifiedBy: c.classifiedBy,
  rulesReason: c.rulesReason,
  model: c.model,
  promptHash: c.promptHash,
  escalated: c.escalated,
  escalationCapped: c.escalationCapped,
  lowConfidence: c.lowConfidence,
  inputTokens: c.usage.input,
  outputTokens: c.usage.output,
  cachedTokens: c.usage.cached,
  classifiedAt: c.classifiedAt,
})

/** Runs classify work in one tenant transaction on Postgres. */
export function pgClassifyRunner(db: Database): ClassifyDeps['run'] {
  return (tenant, fn) => withTenant(db, scopeOfRef(tenant), (tx) => fn(pgClassificationStore(tx)))
}
