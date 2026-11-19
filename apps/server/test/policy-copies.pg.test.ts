// The copies of the policy that classify, triage and moderation keep, on Postgres: filled from
// policy.updated, and on an upgrade started from the config the policy service took over.
// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { pgModerationPolicyCopy, moderationTables } from '@flagwise/moderation'
import { classifyTables, pgClassifyPolicyCopy } from '@flagwise/classify'
import { DEFAULT_POLICY, eventContract, policyIn, type Policy } from '@flagwise/contracts'
import { manualClock, type AppRef } from '@flagwise/kernel'
import { createDatabase, createPgBus, migrate, subscribeCopy, withApps, type Database, type DocumentCopy, type PgBus } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { busPolicyEvents, pgPolicy, PRESETS } from '@flagwise/policy'
import { createApp, pgTenancyStore, tenancyMigrations } from '@flagwise/tenancy'
import { pgTriagePolicyCopy, triageTables } from '@flagwise/triage'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALL_MIGRATIONS } from '../src/migrations.ts'

const A: AppRef = { appId: 'app_jane', livemode: true }
const clock = manualClock('2026-11-18T09:00:00Z')

const seedApp = (db: Database) =>
  withApps(db, { appIds: [A.appId], livemode: true }, async (tx) => {
    const deps = { store: pgTenancyStore(tx), clock, newId: (p: string) => `${p}_1` }
    await createApp(deps, { id: A.appId, name: 'Jane Doe Dating iOS' })
  })
interface PolicyCopies {
  readonly classify: DocumentCopy<Policy>
  readonly triage: DocumentCopy<Policy>
  readonly cases: DocumentCopy<Policy>
}
/** Each copy's group, as each service subscribes it. */
const subscribePolicyCopies = (bus: PgBus, copies: PolicyCopies) => {
  for (const [service, copy] of Object.entries(copies)) {
    subscribeCopy(bus, `${service}.policy`, 'policy.updated.v1', copy, (d) => {
      const u = d as { version: number; policy: Policy }
      return { version: u.version, document: u.policy }
    })
  }
}
const copiesOf = (db: Database): PolicyCopies => ({ classify: pgClassifyPolicyCopy(db), triage: pgTriagePolicyCopy(db), cases: pgModerationPolicyCopy(db) })
const versions = async (copies: PolicyCopies, appRef: AppRef) =>
  Object.fromEntries(await Promise.all(Object.entries(copies).map(async ([name, copy]) => [name, (await copy.get(appRef))?.version ?? null])))

describe.skipIf(!testDatabaseUrl)('policy copies on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  let copies: PolicyCopies

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, ALL_MIGRATIONS, t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { retryDelayMs: () => 0, contract: eventContract })
    copies = copiesOf(db)
    subscribePolicyCopies(bus, copies)
    await bus.drain()
    await seedApp(db)
  })
  afterAll(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
  })

  it('match their migrations', async () => {
    expect(await schemaDrift(t.ownerUrl, [...classifyTables, ...triageTables, ...moderationTables])).toEqual([])
  })

  it("read as the default policy until the app's first version reaches them", async () => {
    expect(await versions(copies, A)).toEqual({ classify: null, triage: null, cases: null })
    expect(await policyIn(copies.triage, A)).toEqual(DEFAULT_POLICY)
  })

  it('each take every version of the policy the policy service publishes', async () => {
    const policy = pgPolicy(db, { clock, events: (tx) => busPolicyEvents(bus, tx, () => `evt_${crypto.randomUUID()}`) })
    await policy.replaceCategories(A, PRESETS.dating)
    await policy.setLlmSettings(A, { rulesOnly: true, fallbackToRules: false })
    await bus.drain()
    expect(await versions(copies, A)).toEqual({ classify: 2, triage: 2, cases: 2 })
    expect(await policyIn(copies.cases, A)).toEqual({ categories: PRESETS.dating, actionKeys: [], llm: { rulesOnly: true, fallbackToRules: false } })
    // The test mode has its own policy, still the default.
    expect(await versions(copies, { ...A, livemode: false })).toEqual({ classify: null, triage: null, cases: null })
    expect(await bus.deadLetters()).toEqual([])
  })
})

describe.skipIf(!testDatabaseUrl)('upgrading to policy copies', () => {
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

  it('starts every copy from the config the app had set, at version 1', async () => {
    // A release before the policy service: the config in tenancy's tables.
    await migrate(t.ownerUrl, [tenancyMigrations], t.roles)
    await seedApp(db)
    await withApps(db, { appIds: [A.appId], livemode: true }, (tx) =>
      tx.execute(sql`INSERT INTO tenancy.llm_settings (app_id, livemode, rules_only, fallback_to_rules, updated_at) VALUES (${A.appId}, true, false, false, now())`),
    )
    await migrate(t.ownerUrl, ALL_MIGRATIONS, t.roles)
    const copies = copiesOf(db)
    const expected = { version: 1, document: { ...DEFAULT_POLICY, llm: { rulesOnly: false, fallbackToRules: false } } }
    expect(await copies.classify.get(A)).toEqual(expected)
    expect(await copies.triage.get(A)).toEqual(expected)
    expect(await copies.cases.get(A)).toEqual(expected)
  })
})
