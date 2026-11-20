// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type ManualClock, type AppRef } from '@flagwise/kernel'
import { createDatabase, migrate, withApps, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  listActionKeys,
  parseActionKeys,
  pgActionKeyStore,
  pgPolicy,
  pgPolicyStores,
  policyMigrations,
  policyTables,
  PRESETS,
  replaceActionKeys,
  type ActionKey,
  type PolicyDeps,
  type PolicyEvent,
} from '../src/index.ts'

const A: AppRef = { appId: 'app_a', livemode: true }

const keysOf = (input: unknown[]): readonly ActionKey[] => {
  const parsed = parseActionKeys(input)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.keys
}
const warn = { key: 'warn', label: { en: 'Warn' }, categories: ['*'] }
const suspend = { key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: 'Blocks sign-in', reverse_key: 'unsuspend', categories: ['scams_fraud'] }
const unsuspend = { key: 'unsuspend', label: { en: 'Lift suspension' }, categories: ['*'] }

describe.skipIf(!testDatabaseUrl)('the policy on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let clock: ManualClock
  const published: PolicyEvent[] = []
  const events = { publish: async (e: PolicyEvent) => void published.push(e) }
  /** The policy use cases' deps in an app transaction of app A in one mode. */
  const inApp = <R>(livemode: boolean, fn: (appRef: AppRef, deps: PolicyDeps) => Promise<R>, appIds = ['app_a']) =>
    withApps(db, { appIds, livemode }, (tx) => fn({ ...A, livemode }, { stores: pgPolicyStores(tx), clock, events }))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [policyMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    clock = manualClock('2026-11-18T09:00:00Z')
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, policyTables)).toEqual([])
  })

  describe('action keys', () => {
    it('replaces the list in its order, keeps removed keys out of it, and brings a key back with its new definition', async () => {
      published.length = 0
      const first = await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([suspend, unsuspend, warn])))
      expect(published.filter((e) => e.type === 'config.action_keys_replaced')).toEqual([{ type: 'config.action_keys_replaced', appRef: A, appId: 'app_a', before: [], after: first, occurredAt: clock.now() }])
      // The same list again changes nothing and publishes nothing.
      await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([suspend, unsuspend, warn])))
      expect(published).toHaveLength(2)
      expect(first.map((k) => k.key)).toEqual(['suspend_7d', 'unsuspend', 'warn'])
      expect(first[0]).toEqual({ key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: 'Blocks sign-in', reverseKey: 'unsuspend', autoAllowed: false, categories: ['scams_fraud'] })

      clock.advance(60_000)
      await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([warn])))
      expect((await inApp(true, (appRef, deps) => listActionKeys(deps.stores, appRef))).map((k) => k.key)).toEqual(['warn'])
      // The removed keys keep their rows.
      const rows = await withApps(db, { appIds: ['app_a'], livemode: true }, (tx) => tx.execute(sql`SELECT key, removed_at IS NOT NULL AS removed FROM policy.action_keys ORDER BY key`))
      expect(rows.rows).toEqual([
        { key: 'suspend_7d', removed: true },
        { key: 'unsuspend', removed: true },
        { key: 'warn', removed: false },
      ])

      const back = await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([{ ...warn, label: { en: 'Send a warning' } }, { ...suspend, categories: ['*'] }, unsuspend])))
      expect(back.map((k) => [k.key, k.label.en, k.categories])).toEqual([
        ['warn', 'Send a warning', ['*']],
        ['suspend_7d', 'Suspend 7 days', ['*']],
        ['unsuspend', 'Lift suspension', ['*']],
      ])
      expect(await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, []))).toEqual([])
    })

    it('keeps each mode and app apart', async () => {
      await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([warn])))
      await inApp(false, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([unsuspend])))
      expect((await inApp(true, (appRef, deps) => listActionKeys(deps.stores, appRef))).map((k) => k.key)).toEqual(['warn'])
      expect((await inApp(false, (appRef, deps) => listActionKeys(deps.stores, appRef))).map((k) => k.key)).toEqual(['unsuspend'])
      // A transaction scoped to another app sees none of them, even asking by id, and cannot write them.
      expect(await inApp(true, (appRef, deps) => listActionKeys(deps.stores, appRef), ['app_other'])).toEqual([])
      expect(await withApps(db, { appIds: ['app_b'], livemode: true }, (tx) => pgActionKeyStore(tx).list(A))).toEqual([])
      await expect(withApps(db, { appIds: ['app_b'], livemode: true }, (tx) => pgActionKeyStore(tx).replace(A, keysOf([warn]), clock.now()))).rejects.toThrow()
    })
  })

  describe('versions', () => {
    it('counts each change of the policy, per mode, and stores the whole policy as the head', async () => {
      published.length = 0
      const before = await inApp(true, (appRef, deps) => deps.stores.heads.lock(appRef))
      await inApp(true, (appRef, deps) => replaceActionKeys(deps, appRef, keysOf([suspend, unsuspend])))
      const head = await inApp(true, (appRef, deps) => deps.stores.heads.lock(appRef))
      expect(head?.version).toBe(before!.version + 1)
      expect(published.find((e) => e.type === 'policy.updated')).toEqual({ type: 'policy.updated', appRef: A, appId: 'app_a', version: head!.version, policy: head!.policy, occurredAt: clock.now() })
      expect(head!.policy.actionKeys.map((k) => k.key)).toEqual(['suspend_7d', 'unsuspend'])
      // The test mode has its own count.
      expect((await inApp(false, (appRef, deps) => deps.stores.heads.lock(appRef)))?.version).toBe(1)
    })

    it('gives every one of several concurrent changes its own version, the last holding all of them', async () => {
      published.length = 0
      const start = (await inApp(true, (appRef, deps) => deps.stores.heads.lock(appRef)))!.version
      const policy = pgPolicy(db, { clock, events: () => events })
      await Promise.all([
        policy.replaceCategories(A, PRESETS.community),
        policy.replaceActionKeys(A, keysOf([warn])),
        policy.setLlmSettings(A, { rulesOnly: true, fallbackToRules: false }),
      ])
      const versions = published.flatMap((e) => (e.type === 'policy.updated' ? [e.version] : [])).sort((a, b) => a - b)
      expect(versions).toEqual([start + 1, start + 2, start + 3])
      const head = await inApp(true, (appRef, deps) => deps.stores.heads.lock(appRef))
      expect(head).toEqual({ version: start + 3, policy: { categories: PRESETS.community, actionKeys: keysOf([warn]), llm: { rulesOnly: true, fallbackToRules: false } } })
    })
  })
})
