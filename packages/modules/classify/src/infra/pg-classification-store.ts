// The ClassificationStore on Postgres, and the classify transaction runner.

import type { AppRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfApp, withApps, type Database, type MigrationSet, type AppTx } from '@flagwise/platform'
import { and, count, eq, gte, inArray, or, sql } from 'drizzle-orm'
import type { ClassificationRecord, ClassificationStore, ClassifyDeps } from '../app/ports.ts'
import { reportScreeningsTable as rs, classificationsTable as t } from './schema.ts'

export const classifyMigrations: MigrationSet = loadMigrations('classify', new URL('./migrations/', import.meta.url))

/** A ClassificationStore on the given app transaction. Records read back equal the records written. */
export function pgClassificationStore(tx: AppTx): ClassificationStore {
  const appOf = (appRef: AppRef) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode))

  return {
    async find(appRef, caseId) {
      const [r] = await tx.select().from(t).where(and(appOf(appRef), eq(t.caseId, caseId)))
      if (!r) return null
      return {
        appRef: { appId: r.appId, livemode: r.livemode },
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
        .values({ appId: c.appRef.appId, livemode: c.appRef.livemode, caseId: c.caseId, ...columns(c) })
        .onConflictDoNothing({ target: [t.appId, t.caseId] })
        .returning({ caseId: t.caseId })
      return inserted.length === 1
    },

    async replaceFailed(c) {
      const replaced = await tx
        .update(t)
        .set(columns(c))
        .where(and(appOf(c.appRef), eq(t.caseId, c.caseId), eq(t.classifiedBy, 'rules'), eq(t.rulesReason, 'llm_failed')))
        .returning({ caseId: t.caseId })
      return replaced.length === 1
    },

    async monthCounts(appRef, since) {
      const [row] = await tx
        .select({ cases: count(), escalations: sql`count(*) FILTER (WHERE ${t.escalated})`.mapWith(Number) })
        .from(t)
        .where(and(appOf(appRef), eq(t.classifiedBy, 'llm'), gte(t.classifiedAt, since)))
      return { cases: row?.cases ?? 0, escalations: row?.escalations ?? 0 }
    },

    async keepScreening(s) {
      await tx
        .insert(rs)
        .values({
          appId: s.appRef.appId,
          livemode: s.appRef.livemode,
          reportId: s.reportId,
          p0Signals: [...s.p0Signals],
          injectionSuspected: s.injectionSuspected,
          reportedExternalId: s.reportedExternalId ?? null,
          reporterExternalId: s.reporterExternalId ?? null,
          evidenceRef: s.evidenceRef,
        })
        .onConflictDoNothing()
    },

    async eraseAccount(appRef, externalId, erasedId) {
      const ofApp = and(eq(rs.appId, appRef.appId), eq(rs.livemode, appRef.livemode))
      const reports = await tx
        .update(rs)
        .set({
          reportedExternalId: sql`CASE WHEN ${rs.reportedExternalId} = ${externalId} THEN ${erasedId} ELSE ${rs.reportedExternalId} END`,
          reporterExternalId: sql`CASE WHEN ${rs.reporterExternalId} = ${externalId} THEN ${erasedId} ELSE ${rs.reporterExternalId} END`,
        })
        .where(and(ofApp, or(eq(rs.reportedExternalId, externalId), eq(rs.reporterExternalId, externalId))))
        .returning({ reportId: rs.reportId })
      if (reports.length > 0) {
        await tx
          .update(t)
          .set({ summary: null })
          .where(and(appOf(appRef), inArray(t.reportId, reports.map((r) => r.reportId))))
      }
      return reports.length
    },

    async findScreening(appRef, reportId) {
      const [r] = await tx
        .select()
        .from(rs)
        .where(and(eq(rs.appId, appRef.appId), eq(rs.livemode, appRef.livemode), eq(rs.reportId, reportId)))
      return r
        ? {
            appRef: { appId: r.appId, livemode: r.livemode },
            reportId: r.reportId,
            p0Signals: r.p0Signals,
            injectionSuspected: r.injectionSuspected,
            evidenceRef: r.evidenceRef,
            ...(r.reportedExternalId !== null && { reportedExternalId: r.reportedExternalId }),
            ...(r.reporterExternalId !== null && { reporterExternalId: r.reporterExternalId }),
          }
        : null
    },
  }
}

/** The columns of a record other than its app and case. */
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

/** Runs classify work in one app transaction on Postgres. */
export function pgClassifyRunner(db: Database): ClassifyDeps['run'] {
  return (appRef, fn) => withApps(db, scopeOfApp(appRef), (tx) => fn(pgClassificationStore(tx)))
}
