// Action keys on Postgres, inside an app transaction (row-level security limits it to its apps
// and the mode).

import type { AppTx } from '@flagwise/platform'
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import type { ActionKeyStore } from '../app/ports.ts'
import type { ActionKey } from '../domain/action-keys.ts'
import { actionKeysTable as t } from './schema.ts'

export function pgActionKeyStore(tx: AppTx): ActionKeyStore {
  const ofApp = (appRef: { appId: string; livemode: boolean }) => and(eq(t.appId, appRef.appId), eq(t.livemode, appRef.livemode))
  const store: ActionKeyStore = {
    async list(appRef) {
      const rows = await tx.select().from(t).where(and(ofApp(appRef), isNull(t.removedAt))).orderBy(asc(t.position))
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

    async replace(appRef, keys, now) {
      // A transaction-scoped advisory lock, so two replaces of one app and mode never mix their lists.
      const lock = `policy.action_keys:${appRef.appId}:${appRef.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`)
      const before = await store.list(appRef)
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
          .values({ appId: appRef.appId, livemode: appRef.livemode, key: k.key, ...row })
          .onConflictDoUpdate({ target: [t.appId, t.livemode, t.key], set: row })
      }
      const kept = keys.map((k) => k.key)
      await tx
        .update(t)
        .set({ removedAt: now, updatedAt: now })
        .where(and(ofApp(appRef), isNull(t.removedAt), ...(kept.length ? [notInArray(t.key, kept)] : [])))
      return before
    },
  }
  return store
}
