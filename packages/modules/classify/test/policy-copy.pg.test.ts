// classify's copy of each app's policy, kept from policy.updated: it boots alone on its own tables and
// takes the facts the policy service publishes. Runs against a real Postgres; skipped without it.
import { currentType, DEFAULT_POLICY, eventContract, policyIn, type EventData, type Policy } from '@flagwise/contracts'
import { manualClock, type AppRef } from '@flagwise/kernel'
import { createDatabase, createPgBus, createPgScheduler, memoryStorage, migrate, type Database, type PgBus } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pgClassifyPolicyCopy, classify, classifyTables } from '../src/index.ts'

const A: AppRef = { appId: 'app_jane', livemode: true }
const clock = manualClock('2026-11-21T09:00:00Z')
const withLlmOff: Policy = { ...DEFAULT_POLICY, llm: { rulesOnly: true, fallbackToRules: false } }

describe.skipIf(!testDatabaseUrl)('classify\'s policy copy', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  const published = async (appRef: AppRef, version: number, policy: Policy) => {
    const data: EventData<'policy.updated.v1'> = { appId: appRef.appId, version, policy, occurredAt: clock.now().toISOString() }
    await bus.publish({ id: `policy.updated:${appRef.appId}:${appRef.livemode}:${version}`, type: currentType('policy.updated'), key: appRef.appId, data, appRef })
    await bus.drain()
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [classify.migrations!], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { retryDelayMs: () => 0, contract: eventContract })
    const runtime = { db, bus, scheduler: createPgScheduler(db, { clock }), clock, onError: (err: unknown) => { throw err } }
    classify.boot(runtime, { storage: memoryStorage(), llm: undefined, redact: true })
    await bus.drain()
  })
  afterAll(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, classifyTables)).toEqual([])
  })

  it("reads as the default policy until the app's first version reaches it", async () => {
    expect(await pgClassifyPolicyCopy(db).get(A)).toBeNull()
    expect(await policyIn(pgClassifyPolicyCopy(db), A)).toEqual(DEFAULT_POLICY)
  })

  it('takes every version the policy service publishes, and never goes back to an older one', async () => {
    await published(A, 1, DEFAULT_POLICY)
    await published(A, 2, withLlmOff)
    expect(await pgClassifyPolicyCopy(db).get(A)).toMatchObject({ version: 2 })
    expect(await policyIn(pgClassifyPolicyCopy(db), A)).toEqual(withLlmOff)
    await published(A, 1, DEFAULT_POLICY)
    expect(await pgClassifyPolicyCopy(db).get(A)).toMatchObject({ version: 2 })
    // The test mode has its own policy, still the default.
    expect(await pgClassifyPolicyCopy(db).get({ ...A, livemode: false })).toBeNull()
    expect(await bus.deadLetters()).toEqual([])
  })
})
