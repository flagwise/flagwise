// The policy on Postgres: its stores inside a tenant transaction (row-level security limits them to
// that org, its apps and the mode), and the routes' use cases, each in its own tenant transaction.

import type { Policy } from '@flagwise/contracts'
import type { Clock, TenantRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfRef, withTenant, type Database, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, eq, sql } from 'drizzle-orm'
import type { ConfigRoutesDeps } from '../api/routes.ts'
import { getLlmSettings, listActionKeys, listCategories, replaceActionKeys, replaceCategories, reportScreenCategories, setLlmSettings } from '../app/policy.ts'
import type { PolicyEventPublisher, PolicyHeadStore, PolicyStores } from '../app/ports.ts'
import { pgActionKeyStore } from './pg-action-key-store.ts'
import { pgCategoryStore, pgLlmSettingsStore } from './pg-category-store.ts'
import { headsTable as h } from './schema.ts'

export const policyMigrations: MigrationSet = loadMigrations('policy', new URL('./migrations/', import.meta.url))

export function pgPolicyHeadStore(tx: TenantTx): PolicyHeadStore {
  const ofApp = (tenant: TenantRef) => and(eq(h.orgId, tenant.orgId), eq(h.appId, tenant.appId), eq(h.livemode, tenant.livemode))
  return {
    async lock(tenant) {
      // A transaction-scoped advisory lock: the head may not exist yet, so there is no row to lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`policy:${tenant.orgId}:${tenant.appId}:${tenant.livemode}`}, 0))`)
      const [row] = await tx.select({ version: h.version, document: h.document }).from(h).where(ofApp(tenant))
      return row ? { version: row.version, policy: row.document as Policy } : null
    },

    async set(tenant, head, now) {
      const row = { version: head.version, document: head.policy, updatedAt: now }
      await tx
        .insert(h)
        .values({ orgId: tenant.orgId, appId: tenant.appId, livemode: tenant.livemode, ...row })
        .onConflictDoUpdate({ target: [h.orgId, h.appId, h.livemode], set: row })
    },
  }
}

export function pgPolicyStores(tx: TenantTx): PolicyStores {
  return { categories: pgCategoryStore(tx), actionKeys: pgActionKeyStore(tx), llm: pgLlmSettingsStore(tx), heads: pgPolicyHeadStore(tx) }
}

export interface PgPolicyOptions {
  readonly clock: Clock
  /** Where the policy's events go, in the transaction of the change. */
  readonly events: (tx: TenantTx) => PolicyEventPublisher
}

/** The policy's use cases on `db`, each in one tenant transaction: what the config routes need. */
export function pgPolicy(db: Database, opts: PgPolicyOptions): ConfigRoutesDeps {
  const read = <R>(tenant: TenantRef, fn: (stores: PolicyStores) => Promise<R>) => withTenant(db, scopeOfRef(tenant), (tx) => fn(pgPolicyStores(tx)))
  const write = <R>(tenant: TenantRef, fn: (deps: { stores: PolicyStores; clock: Clock; events: PolicyEventPublisher }) => Promise<R>) =>
    withTenant(db, scopeOfRef(tenant), (tx) => fn({ stores: pgPolicyStores(tx), clock: opts.clock, events: opts.events(tx) }))
  return {
    listActionKeys: (tenant) => read(tenant, (s) => listActionKeys(s, tenant)),
    replaceActionKeys: (tenant, keys) => write(tenant, (d) => replaceActionKeys(d, tenant, keys)),
    listCategories: (tenant) => read(tenant, (s) => listCategories(s, tenant)),
    replaceCategories: (tenant, categories) => write(tenant, (d) => replaceCategories(d, tenant, categories)),
    reportScreenCategories: (tenant, locale) => read(tenant, (s) => reportScreenCategories(s, tenant, locale)),
    getLlmSettings: (tenant) => read(tenant, (s) => getLlmSettings(s, tenant)),
    setLlmSettings: (tenant, settings) => write(tenant, (d) => setLlmSettings(d, tenant, settings)),
  }
}
