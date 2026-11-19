// Categories and LLM settings on Postgres, inside a tenant transaction (row-level security limits it
// to that org, its apps and the mode).

import type { GlobalSeverity } from '@flagwise/contracts'
import type { TenantRef } from '@flagwise/kernel'
import type { TenantTx } from '@flagwise/platform'
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

export function pgCategoryStore(tx: TenantTx): CategoryStore {
  const ofApp = (tenant: TenantRef) => and(eq(t.orgId, tenant.orgId), eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode))
  const store: CategoryStore = {
    async list(tenant) {
      const rows = await tx.select().from(t).where(and(ofApp(tenant), isNull(t.removedAt))).orderBy(asc(t.position))
      return rows.map(toCategory)
    },

    async replace(tenant, categories, now) {
      // A transaction-scoped advisory lock, so two replaces of one app and mode never mix their lists.
      const lock = `policy.categories:${tenant.orgId}:${tenant.appId}:${tenant.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`)
      const before = await store.list(tenant)
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
          .values({ orgId: tenant.orgId, appId: tenant.appId, livemode: tenant.livemode, key: c.key, ...row })
          .onConflictDoUpdate({ target: [t.orgId, t.appId, t.livemode, t.key], set: row })
      }
      const kept = categories.map((c) => c.key)
      await tx
        .update(t)
        .set({ removedAt: now, updatedAt: now })
        .where(and(ofApp(tenant), isNull(t.removedAt), ...(kept.length ? [notInArray(t.key, kept)] : [])))
      return before
    },
  }
  return store
}

export function pgLlmSettingsStore(tx: TenantTx): LlmSettingsStore {
  const ofApp = (tenant: TenantRef) => and(eq(s.orgId, tenant.orgId), eq(s.appId, tenant.appId), eq(s.livemode, tenant.livemode))
  const store: LlmSettingsStore = {
    async get(tenant) {
      const [row] = await tx.select().from(s).where(ofApp(tenant))
      return row ? { rulesOnly: row.rulesOnly, fallbackToRules: row.fallbackToRules } : DEFAULT_LLM_SETTINGS
    },

    async set(tenant, settings, now) {
      const lock = `policy.llm_settings:${tenant.orgId}:${tenant.appId}:${tenant.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`)
      const before = await store.get(tenant)
      const row = { rulesOnly: settings.rulesOnly, fallbackToRules: settings.fallbackToRules, updatedAt: now }
      await tx
        .insert(s)
        .values({ orgId: tenant.orgId, appId: tenant.appId, livemode: tenant.livemode, ...row })
        .onConflictDoUpdate({ target: [s.orgId, s.appId, s.livemode], set: row })
      return before
    },
  }
  return store
}
