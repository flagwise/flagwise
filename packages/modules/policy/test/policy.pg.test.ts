// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { DEFAULT_POLICY } from '@flagwise/contracts'
import { manualClock, type ManualClock, type TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, withSystem, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { createApp, pgTenancyStore, tenancyMigrations } from '@flagwise/tenancy'
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

const A: TenantRef = { appId: 'app_a', livemode: true }

/** Creates app A and app B. */
async function seedApps(db: Database, clock: ManualClock) {
  let n = 0
  const asApp = (appId: string, fn: (d: Parameters<typeof createApp>[0]) => Promise<void>) =>
    withTenant(db, { appIds: [appId], livemode: true }, (tx) => fn({ store: pgTenancyStore(tx), clock, newId: (p: string) => `${p}_${++n}` }))
  await asApp('app_a', async (d) => {
    await createApp(d, { id: 'app_a', name: 'Jane Doe Dating iOS' })
  })
  await asApp('app_b', async (d) => {
    await createApp(d, { id: 'app_b', name: 'John Doe Market' })
  })
}

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
  /** The policy use cases' deps in a tenant transaction of app A in one mode. */
  const inApp = <R>(livemode: boolean, fn: (tenant: TenantRef, deps: PolicyDeps) => Promise<R>, appIds = ['app_a']) =>
    withTenant(db, { appIds, livemode }, (tx) => fn({ ...A, livemode }, { stores: pgPolicyStores(tx), clock, events }))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [tenancyMigrations, policyMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    clock = manualClock('2026-11-18T09:00:00Z')
    await seedApps(db, clock)
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
      const first = await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([suspend, unsuspend, warn])))
      expect(published.filter((e) => e.type === 'config.action_keys_replaced')).toEqual([{ type: 'config.action_keys_replaced', tenant: A, appId: 'app_a', before: [], after: first, occurredAt: clock.now() }])
      // The same list again changes nothing and publishes nothing.
      await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([suspend, unsuspend, warn])))
      expect(published).toHaveLength(2)
      expect(first.map((k) => k.key)).toEqual(['suspend_7d', 'unsuspend', 'warn'])
      expect(first[0]).toEqual({ key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: 'Blocks sign-in', reverseKey: 'unsuspend', autoAllowed: false, categories: ['scams_fraud'] })

      clock.advance(60_000)
      await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([warn])))
      expect((await inApp(true, (tenant, deps) => listActionKeys(deps.stores, tenant))).map((k) => k.key)).toEqual(['warn'])
      // The removed keys keep their rows.
      const rows = await withTenant(db, { appIds: ['app_a'], livemode: true }, (tx) => tx.execute(sql`SELECT key, removed_at IS NOT NULL AS removed FROM policy.action_keys ORDER BY key`))
      expect(rows.rows).toEqual([
        { key: 'suspend_7d', removed: true },
        { key: 'unsuspend', removed: true },
        { key: 'warn', removed: false },
      ])

      const back = await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([{ ...warn, label: { en: 'Send a warning' } }, { ...suspend, categories: ['*'] }, unsuspend])))
      expect(back.map((k) => [k.key, k.label.en, k.categories])).toEqual([
        ['warn', 'Send a warning', ['*']],
        ['suspend_7d', 'Suspend 7 days', ['*']],
        ['unsuspend', 'Lift suspension', ['*']],
      ])
      expect(await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, []))).toEqual([])
    })

    it('keeps each mode and app apart', async () => {
      await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([warn])))
      await inApp(false, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([unsuspend])))
      expect((await inApp(true, (tenant, deps) => listActionKeys(deps.stores, tenant))).map((k) => k.key)).toEqual(['warn'])
      expect((await inApp(false, (tenant, deps) => listActionKeys(deps.stores, tenant))).map((k) => k.key)).toEqual(['unsuspend'])
      // A transaction scoped to another app sees none of them, even asking by id, and cannot write them.
      expect(await inApp(true, (tenant, deps) => listActionKeys(deps.stores, tenant), ['app_other'])).toEqual([])
      expect(await withTenant(db, { appIds: ['app_b'], livemode: true }, (tx) => pgActionKeyStore(tx).list(A))).toEqual([])
      await expect(withTenant(db, { appIds: ['app_b'], livemode: true }, (tx) => pgActionKeyStore(tx).replace(A, keysOf([warn]), clock.now()))).rejects.toThrow()
    })
  })

  describe('versions', () => {
    it('counts each change of the policy, per mode, and stores the whole policy as the head', async () => {
      published.length = 0
      const before = await inApp(true, (tenant, deps) => deps.stores.heads.lock(tenant))
      await inApp(true, (tenant, deps) => replaceActionKeys(deps, tenant, keysOf([suspend, unsuspend])))
      const head = await inApp(true, (tenant, deps) => deps.stores.heads.lock(tenant))
      expect(head?.version).toBe(before!.version + 1)
      expect(published.find((e) => e.type === 'policy.updated')).toEqual({ type: 'policy.updated', tenant: A, appId: 'app_a', version: head!.version, policy: head!.policy, occurredAt: clock.now() })
      expect(head!.policy.actionKeys.map((k) => k.key)).toEqual(['suspend_7d', 'unsuspend'])
      // The test mode has its own count.
      expect((await inApp(false, (tenant, deps) => deps.stores.heads.lock(tenant)))?.version).toBe(1)
    })

    it('gives every one of several concurrent changes its own version, the last holding all of them', async () => {
      published.length = 0
      const start = (await inApp(true, (tenant, deps) => deps.stores.heads.lock(tenant)))!.version
      const policy = pgPolicy(db, { clock, events: () => events })
      await Promise.all([
        policy.replaceCategories(A, PRESETS.community),
        policy.replaceActionKeys(A, keysOf([warn])),
        policy.setLlmSettings(A, { rulesOnly: true, fallbackToRules: false }),
      ])
      const versions = published.flatMap((e) => (e.type === 'policy.updated' ? [e.version] : [])).sort((a, b) => a - b)
      expect(versions).toEqual([start + 1, start + 2, start + 3])
      const head = await inApp(true, (tenant, deps) => deps.stores.heads.lock(tenant))
      expect(head).toEqual({ version: start + 3, policy: { categories: PRESETS.community, actionKeys: keysOf([warn]), llm: { rulesOnly: true, fallbackToRules: false } } })
    })
  })
})

describe.skipIf(!testDatabaseUrl)('upgrading to the policy service', () => {
  let t: TestDatabase
  let db: Database

  beforeAll(async () => {
    t = await createTestDatabase()
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it("moves an app's config from tenancy and starts its policy at version 1 with what it set", async () => {
    await migrate(t.ownerUrl, [tenancyMigrations], t.roles)
    await seedApps(db, manualClock('2026-11-18T09:00:00Z'))
    // What a release before the policy service stored, through the app role.
    await withTenant(db, { appIds: ['app_a'], livemode: true }, async (tx) => {
      await tx.execute(sql`INSERT INTO tenancy.categories (app_id, livemode, key, position, label_en, label_id, maps_to, severity, sla_hours, enabled, updated_at, removed_at) VALUES
        ('app_a', true, 'scam', 1, 'Scam', 'Penipuan', '{scams_fraud}', NULL, NULL, true, now(), NULL),
        ('app_a', true, 'fake_sugar_daddy', 0, 'Fake sugar daddy', NULL, '{scams_fraud.romance_scam}', 'P1', 12, false, now(), NULL),
        ('app_a', true, 'gone', 2, 'Gone', NULL, '{}', NULL, NULL, true, now(), now())`)
      await tx.execute(sql`INSERT INTO tenancy.action_keys (app_id, livemode, key, position, label_en, label_id, description, reverse_key, auto_allowed, categories, updated_at, removed_at) VALUES
        ('app_a', true, 'warn', 0, 'Warn', NULL, 'A warning', NULL, false, '{*}', now(), NULL)`)
    })
    await withTenant(db, { appIds: ['app_b'], livemode: false }, (tx) =>
      tx.execute(sql`INSERT INTO tenancy.llm_settings (app_id, livemode, rules_only, fallback_to_rules, updated_at) VALUES ('app_b', false, true, false, now())`),
    )

    expect(await migrate(t.ownerUrl, [tenancyMigrations, policyMigrations], t.roles)).toEqual(['policy/0001_policy'])

    const headOf = (tenant: TenantRef) => withTenant(db, { appIds: [tenant.appId], livemode: tenant.livemode }, (tx) => pgPolicyStores(tx).heads.lock(tenant))
    expect(await headOf(A)).toEqual({
      version: 1,
      policy: {
        categories: [
          { key: 'fake_sugar_daddy', label: { en: 'Fake sugar daddy', id: null }, mapsTo: ['scams_fraud.romance_scam'], severity: 'P1', slaHours: 12, enabled: false },
          { key: 'scam', label: { en: 'Scam', id: 'Penipuan' }, mapsTo: ['scams_fraud'], severity: null, slaHours: null, enabled: true },
        ],
        actionKeys: [{ key: 'warn', label: { en: 'Warn', id: null }, description: 'A warning', reverseKey: null, autoAllowed: false, categories: ['*'] }],
        llm: DEFAULT_POLICY.llm,
      },
    })
    expect(await headOf({ appId: 'app_b', livemode: false })).toEqual({ version: 1, policy: { ...DEFAULT_POLICY, llm: { rulesOnly: true, fallbackToRules: false } } })
    // An app that set nothing has no version yet.
    expect(await headOf({ appId: 'app_b', livemode: true })).toBeNull()
    // The moved config reads as before, through the policy's stores.
    expect((await withTenant(db, { appIds: ['app_a'], livemode: true }, (tx) => pgActionKeyStore(tx).list(A))).map((k) => k.key)).toEqual(['warn'])

    // Row-level security is forced again on every table.
    const { rows } = await withSystem(db, (tx) =>
      tx.execute(sql`SELECT c.relname, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'policy' AND c.relkind = 'r' ORDER BY c.relname`),
    )
    expect(rows).toEqual([
      { relname: 'action_keys', forced: true },
      { relname: 'categories', forced: true },
      { relname: 'heads', forced: true },
      { relname: 'llm_settings', forced: true },
    ])
  })
})
