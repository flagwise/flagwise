// Action keys on Postgres, inside a tenant transaction (row-level security limits it to that org,
// its apps and the mode).

import type { TenantTx } from '@flagwise/platform'
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { ActionKeyStore } from '../app/ports.ts'
import type { ActionKey } from '../domain/action-keys.ts'
import { actionKeysTable as t } from './schema.ts'

export function pgActionKeyStore(tx: TenantTx): ActionKeyStore {
  const ofApp = (tenant: { orgId: string; appId: string; livemode: boolean }) => and(eq(t.orgId, tenant.orgId), eq(t.appId, tenant.appId), eq(t.livemode, tenant.livemode))
  const store: ActionKeyStore = {
    async list(tenant) {
      const rows = await tx.select().from(t).where(and(ofApp(tenant), isNull(t.removedAt))).orderBy(asc(t.position))
      return rows.map(
        (r): ActionKey => ({
          key: r.key,
          label: { en: r.labelEn, id: r.labelId },
          description: r.description,
          reverseKey: r.reverseKey,
          autoAllowed: r.autoAllowed,
          categories: r.categories,
        }),
      )
    },

    async replace(tenant, keys, now) {
      // A transaction-scoped advisory lock, so two replaces of one app and mode never mix their lists.
      const lock = `policy.action_keys:${tenant.orgId}:${tenant.appId}:${tenant.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`)
      const before = await store.list(tenant)
      for (const [position, k] of keys.entries()) {
        const row = {
          position,
          labelEn: k.label.en,
          labelId: k.label.id,
          description: k.description,
          reverseKey: k.reverseKey,
          autoAllowed: k.autoAllowed,
          categories: [...k.categories],
          updatedAt: now,
          removedAt: null,
        }
        await tx
          .insert(t)
          .values({ orgId: tenant.orgId, appId: tenant.appId, livemode: tenant.livemode, key: k.key, ...row })
          .onConflictDoUpdate({ target: [t.orgId, t.appId, t.livemode, t.key], set: row })
      }
      const kept = keys.map((k) => k.key)
      await tx
        .update(t)
        .set({ removedAt: now, updatedAt: now })
        .where(and(ofApp(tenant), isNull(t.removedAt), ...(kept.length ? [notInArray(t.key, kept)] : [])))
      return before
    },
  }
  return store
}
