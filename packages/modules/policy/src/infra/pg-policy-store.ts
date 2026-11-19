// The policy on Postgres: its stores inside an app transaction (row-level security limits them to
// its apps and the mode), and the routes' use cases, each in its own app transaction.

import type { Policy } from '@flagwise/contracts'
import type { Clock, AppRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfApp, withApps, type Database, type MigrationSet, type AppTx } from '@flagwise/platform'
import { and, eq, sql } from 'drizzle-orm'
import type { PolicyRoutesDeps } from '../api/routes.ts'
import { getLlmSettings, listActionKeys, listCategories, replaceActionKeys, replaceCategories, reportScreenCategories, setLlmSettings } from '../app/policy.ts'
import type { PolicyEventPublisher, PolicyHeadStore, PolicyStores } from '../app/ports.ts'
import { pgActionKeyStore } from './pg-action-key-store.ts'
import { pgCategoryStore, pgLlmSettingsStore } from './pg-category-store.ts'
import { headsTable as h } from './schema.ts'

export const policyMigrations: MigrationSet = loadMigrations('policy', new URL('./migrations/', import.meta.url))

export function pgPolicyHeadStore(tx: AppTx): PolicyHeadStore {
  const ofApp = (appRef: AppRef) => and(eq(h.appId, appRef.appId), eq(h.livemode, appRef.livemode))
  return {
    async lock(appRef) {
      // A transaction-scoped advisory lock: the head may not exist yet, so there is no row to lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`policy:${appRef.appId}:${appRef.livemode}`}, 0))`)
      const [row] = await tx.select({ version: h.version, document: h.document }).from(h).where(ofApp(appRef))
      return row ? { version: row.version, policy: row.document as Policy } : null
    },

    async set(appRef, head, now) {
      const row = { version: head.version, document: head.policy, updatedAt: now }
      await tx
        .insert(h)
        .values({ appId: appRef.appId, livemode: appRef.livemode, ...row })
        .onConflictDoUpdate({ target: [h.appId, h.livemode], set: row })
    },
  }
}

export function pgPolicyStores(tx: AppTx): PolicyStores {
  return { categories: pgCategoryStore(tx), actionKeys: pgActionKeyStore(tx), llm: pgLlmSettingsStore(tx), heads: pgPolicyHeadStore(tx) }
}

export interface PgPolicyOptions {
  readonly clock: Clock
  /** Where the policy's events go, in the transaction of the change. */
  readonly events: (tx: AppTx) => PolicyEventPublisher
}

/** The policy's use cases on `db`, each in one app transaction: what the config routes need. */
export function pgPolicy(db: Database, opts: PgPolicyOptions): PolicyRoutesDeps {
  const read = <R>(appRef: AppRef, fn: (stores: PolicyStores) => Promise<R>) => withApps(db, scopeOfApp(appRef), (tx) => fn(pgPolicyStores(tx)))
  const write = <R>(appRef: AppRef, fn: (deps: { stores: PolicyStores; clock: Clock; events: PolicyEventPublisher }) => Promise<R>) =>
    withApps(db, scopeOfApp(appRef), (tx) => fn({ stores: pgPolicyStores(tx), clock: opts.clock, events: opts.events(tx) }))
  return {
    listActionKeys: (appRef) => read(appRef, (s) => listActionKeys(s, appRef)),
    replaceActionKeys: (appRef, keys) => write(appRef, (d) => replaceActionKeys(d, appRef, keys)),
    listCategories: (appRef) => read(appRef, (s) => listCategories(s, appRef)),
    replaceCategories: (appRef, categories) => write(appRef, (d) => replaceCategories(d, appRef, categories)),
    reportScreenCategories: (appRef, locale) => read(appRef, (s) => reportScreenCategories(s, appRef, locale)),
    getLlmSettings: (appRef) => read(appRef, (s) => getLlmSettings(s, appRef)),
    setLlmSettings: (appRef, settings) => write(appRef, (d) => setLlmSettings(d, appRef, settings)),
  }
}
