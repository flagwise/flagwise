// Auth on Postgres: the key store works inside an app transaction (row-level security limits it to
// its apps); the key directory reads as the system role; the app copies each write in their own app
// transaction.

import type { ApiKeyScope } from '@flagwise/kernel'
import { loadMigrations, withApps, type AppTx, type Database, type MigrationSet, type SystemTx } from '@flagwise/platform'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { ApiKeyRecord, AppCopies, KeyDirectory, KeyStore } from '../app/keys.ts'
import { apiKeysTable as keys, appsTable as apps } from './schema.ts'

export const authMigrations: MigrationSet = loadMigrations('auth', new URL('./migrations/', import.meta.url))

const toKey = (r: typeof keys.$inferSelect): ApiKeyRecord => ({
  appId: r.appId,
  id: r.id,
  livemode: r.livemode,
  lookup: r.lookup,
  hash: r.hash,
  scopes: r.scopes as ApiKeyScope[],
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
})

/** A KeyStore on the given app transaction; reads and writes also filter by app. */
export function pgKeyStore(tx: AppTx): KeyStore {
  const keyOf = (appId: string, keyId: string) => and(eq(keys.appId, appId), eq(keys.id, keyId))
  return {
    async findApp(appId) {
      const [row] = await tx.select().from(apps).where(eq(apps.id, appId))
      return row ?? null
    },

    async insertApiKey(key) {
      const inserted = await tx
        .insert(keys)
        .values({ ...key, scopes: [...key.scopes] })
        .onConflictDoNothing({ target: keys.lookup })
        .returning({ id: keys.id })
      return inserted.length > 0
    },

    async findApiKey(appId, keyId) {
      const [row] = await tx.select().from(keys).where(keyOf(appId, keyId))
      return row ? toKey(row) : null
    },

    async endApiKey(appId, keyId, end, now) {
      // Still active at `now`, and the new end is earlier than the one it already has.
      const at = 'revokedAt' in end ? end.revokedAt : end.expiresAt
      const changed = await tx
        .update(keys)
        .set('revokedAt' in end ? { revokedAt: end.revokedAt } : { expiresAt: end.expiresAt })
        .where(
          and(
            keyOf(appId, keyId),
            isNull(keys.revokedAt),
            or(isNull(keys.expiresAt), gt(keys.expiresAt, now)),
            'revokedAt' in end ? sql`true` : or(isNull(keys.expiresAt), lt(sql`${at}::timestamptz`, keys.expiresAt)),
          ),
        )
        .returning({ id: keys.id })
      return changed.length > 0
    },
  }
}

/** The key directory, read as the system role. */
export function pgKeyDirectory(tx: SystemTx): KeyDirectory {
  return {
    async findByLookup(lookup) {
      const [row] = await tx
        .select({ key: keys, appDeletedAt: apps.deletedAt })
        .from(keys)
        .innerJoin(apps, eq(apps.id, keys.appId))
        .where(eq(keys.lookup, lookup))
      return row ? { key: toKey(row.key), appDeletedAt: row.appDeletedAt } : null
    },
  }
}

/** Auth's copy of the apps on `db`; each write is its own transaction for that app. */
export function pgAppCopies(db: Database): AppCopies {
  const forApp = (appId: string, fn: (tx: AppTx) => Promise<unknown>) => withApps(db, { appIds: [appId], livemode: true }, async (tx) => void (await fn(tx)))
  return {
    created: (appId) => forApp(appId, (tx) => tx.insert(apps).values({ id: appId, deletedAt: null }).onConflictDoNothing()),
    setDeletedAt: (appId, deletedAt) =>
      forApp(appId, (tx) => tx.insert(apps).values({ id: appId, deletedAt }).onConflictDoUpdate({ target: apps.id, set: { deletedAt } })),
  }
}
