// The tenancy registry on Postgres: the store works inside a tenant transaction (row-level
// security limits it to that org and its apps); the key directory reads as the system role.

import type { ApiKeyScope } from '@flagwise/kernel'
import { loadMigrations, type MigrationSet, type SystemTx, type TenantTx } from '@flagwise/platform'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { ApiKeyRecord, KeyDirectory, TenancyStore } from '../app/registry.ts'
import { apiKeysTable as keys, appsTable as apps, orgsTable as orgs } from './schema.ts'

export const tenancyMigrations: MigrationSet = loadMigrations('tenancy', new URL('./migrations/', import.meta.url))

const toKey = (r: typeof keys.$inferSelect): ApiKeyRecord => ({
  orgId: r.orgId,
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

/** A TenancyStore on the given tenant transaction; reads and writes also filter by org and app. */
export function pgTenancyStore(tx: TenantTx): TenancyStore {
  const keyOf = (orgId: string, appId: string, keyId: string) => and(eq(keys.orgId, orgId), eq(keys.appId, appId), eq(keys.id, keyId))
  return {
    async insertOrg(org) {
      await tx.insert(orgs).values(org)
    },

    async insertApp(app) {
      await tx.insert(apps).values(app)
    },

    async findApp(orgId, appId) {
      const [row] = await tx.select().from(apps).where(and(eq(apps.orgId, orgId), eq(apps.id, appId)))
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

    async findApiKey(orgId, appId, keyId) {
      const [row] = await tx.select().from(keys).where(keyOf(orgId, appId, keyId))
      return row ? toKey(row) : null
    },

    async endApiKey(orgId, appId, keyId, end, now) {
      // Still active at `now`, and the new end is earlier than the one it already has.
      const at = 'revokedAt' in end ? end.revokedAt : end.expiresAt
      const changed = await tx
        .update(keys)
        .set('revokedAt' in end ? { revokedAt: end.revokedAt } : { expiresAt: end.expiresAt })
        .where(
          and(
            keyOf(orgId, appId, keyId),
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
        .select({ key: keys, appDeletedAt: apps.deletedAt, orgDeletedAt: orgs.deletedAt })
        .from(keys)
        .innerJoin(apps, and(eq(apps.orgId, keys.orgId), eq(apps.id, keys.appId)))
        .innerJoin(orgs, eq(orgs.id, keys.orgId))
        .where(eq(keys.lookup, lookup))
      return row ? { key: toKey(row.key), appDeletedAt: row.appDeletedAt, orgDeletedAt: row.orgDeletedAt } : null
    },
  }
}

