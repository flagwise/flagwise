// Categories and LLM settings on Postgres, inside an app transaction (row-level security limits it
// to its apps and the mode).

import type { GlobalSeverity } from '@flagwise/contracts'
import type { AppRef } from '@flagwise/kernel'
import type { AppTx } from '@flagwise/platform'
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { CategoryStore, LlmSettingsStore } from '../app/ports.ts'
import { DEFAULT_LLM_SETTINGS, type AppCategory } from '../domain/categories.ts'
import { categoriesTable as t, llmSettingsTable as s } from './schema.ts'

const toCategory = (r: typeof t.$inferSelect): AppCategory => ({
  key: r.key,
  label: { en: r.labelEn, id: r.labelId },
  mapsTo: r.mapsTo,
  severity: r.severity as GlobalSeverity | null,
  slaHours: r.slaHours,
  enabled: r.enabled,
})

export function pgCategoryStore(tx: AppTx): CategoryStore {
  const ofApp = (appRef: AppRef) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode))
  const store: CategoryStore = {
    async list(appRef) {
      const rows = await tx.select().from(t).where(and(ofApp(appRef), isNull(t.removedAt))).orderBy(asc(t.position))
      return rows.map(toCategory)
    },

    async replace(appRef, categories, now) {
      // A transaction-scoped advisory lock, so two replaces of one app and mode never mix their lists.
      const lock = `policy.categories:${appRef.appId}:${appRef.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`)
      const before = await store.list(appRef)
      for (const [position, c] of categories.entries()) {
        const row = {
          position,
          labelEn: c.label.en,
          labelId: c.label.id,
          mapsTo: [...c.mapsTo],
          severity: c.severity,
          slaHours: c.slaHours,
          enabled: c.enabled,
          updatedAt: now,
          removedAt: null,
        }
        await tx
          .insert(t)
          .values({ appId: appRef.appId, livemode: appRef.livemode, key: c.key, ...row })
          .onConflictDoUpdate({ target: [t.appId, t.livemode, t.key], set: row })
      }
      const kept = categories.map((c) => c.key)
      await tx
        .update(t)
        .set({ removedAt: now, updatedAt: now })
        .where(and(ofApp(appRef), isNull(t.removedAt), ...(kept.length ? [notInArray(t.key, kept)] : [])))
      return before
    },
  }
  return store
}

export function pgLlmSettingsStore(tx: AppTx): LlmSettingsStore {
  const ofApp = (appRef: AppRef) => and(eq(s.appId, appRef.appId), eq(s.livemode, appRef.livemode))
  const store: LlmSettingsStore = {
    async get(appRef) {
      const [row] = await tx.select().from(s).where(ofApp(appRef))
      return row ? { rulesOnly: row.rulesOnly, fallbackToRules: row.fallbackToRules } : DEFAULT_LLM_SETTINGS
    },

    async set(appRef, settings, now) {
      const lock = `policy.llm_settings:${appRef.appId}:${appRef.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`)
      const before = await store.get(appRef)
      const row = { rulesOnly: settings.rulesOnly, fallbackToRules: settings.fallbackToRules, updatedAt: now }
      await tx
        .insert(s)
        .values({ appId: appRef.appId, livemode: appRef.livemode, ...row })
        .onConflictDoUpdate({ target: [s.appId, s.livemode], set: row })
      return before
    },
  }
  return store
}
