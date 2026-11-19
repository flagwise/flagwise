// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import type { TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfRef, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyMigrations, classifyTables, pgClassificationStore, type ClassificationRecord, type ClassificationStore } from '../src/index.ts'

const A: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-06T09:00:00.000Z')

const llm = (caseId: string, over: Partial<ClassificationRecord> = {}): ClassificationRecord => ({
  tenant: A,
  caseId,
  reportId: `rpt_${caseId}`,
  categoryId: 'scams_fraud.romance_scam',
  customCategoryId: null,
  confidence: 0.82,
  signals: ['asking_for_money', 'minor_involved'],
  summary: 'The reported account asked for $200.',
  injectionSuspected: false,
  preRuleP0: true,
  classifiedBy: 'llm',
  rulesReason: null,
  model: 'claude-haiku-5-5',
  promptHash: '0123456789abcdef',
  escalated: false,
  escalationCapped: false,
  lowConfidence: false,
  usage: { input: 1200, output: 150, cached: 3000 },
  classifiedAt: T0,
  ...over,
})

const rules = (caseId: string): ClassificationRecord => ({
  ...llm(caseId),
  categoryId: 'asking_for_money',
  confidence: null,
  signals: [],
  summary: null,
  preRuleP0: false,
  classifiedBy: 'rules',
  rulesReason: 'rules_only',
  model: null,
  promptHash: null,
  usage: { input: 0, output: 0, cached: 0 },
})

describe.skipIf(!testDatabaseUrl)('pgClassificationStore', () => {
  let t: TestDatabase
  let db: Database
  const inTenant = <R>(tenant: TenantRef, fn: (s: ClassificationStore) => Promise<R>) => withTenant(db, scopeOfRef(tenant), (tx) => fn(pgClassificationStore(tx)))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [classifyMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, classifyTables)).toEqual([])
  })

  it('reads back what it wrote, and keeps the first record of a case', async () => {
    for (const record of [llm('case_1'), rules('case_2')]) {
      expect(await inTenant(A, (s) => s.insert(record))).toBe(true)
      expect(await inTenant(A, (s) => s.find(A, record.caseId))).toEqual(record)
    }
    expect(await inTenant(A, (s) => s.insert(llm('case_1', { model: 'claude-sonnet-5-5' })))).toBe(false)
    expect(await inTenant(A, (s) => s.find(A, 'case_1'))).toEqual(llm('case_1'))
    expect(await inTenant(A, (s) => s.find(A, 'case_nope'))).toBeNull()
  })

  it('counts the LLM-classified cases and escalations since a date, per app and mode', async () => {
    const since = new Date('2026-11-01T00:00:00.000Z')
    const B = { ...A, appId: 'app_b' }
    const test = { ...A, livemode: false }
    await inTenant(A, async (s) => {
      await s.insert(llm('case_m1', { escalated: true }))
      await s.insert(llm('case_m2'))
      await s.insert(llm('case_old', { escalated: true, classifiedAt: new Date('2026-10-31T23:59:59.000Z') }))
      await s.insert(rules('case_m3'))
    })
    await inTenant(B, (s) => s.insert(llm('case_b1', { tenant: B, escalated: true })))
    await inTenant(test, (s) => s.insert(llm('case_t1', { tenant: test })))
    // case_1 from the test above also counts.
    expect(await inTenant(A, (s) => s.monthCounts(A, since))).toEqual({ cases: 3, escalations: 1 })
    expect(await inTenant(B, (s) => s.monthCounts(B, since))).toEqual({ cases: 1, escalations: 1 })
    expect(await inTenant(test, (s) => s.monthCounts(test, since))).toEqual({ cases: 1, escalations: 0 })
  })

  it("erases an account: its reports' screenings take the tombstone and their classifications lose the LLM summary", async () => {
    const screening = (reportId: string, reported: string, reporter: string) => ({ tenant: A, reportId, p0Signals: [], injectionSuspected: false, evidenceRef: `apps/app_a/${reportId}`, reportedExternalId: reported, reporterExternalId: reporter })
    await inTenant(A, async (s) => {
      await s.keepScreening(screening('rpt_e1', 'u_john_doe', 'u_jane_doe'))
      await s.keepScreening(screening('rpt_e2', 'u_jim_doe', 'u_john_doe'))
      await s.keepScreening(screening('rpt_e3', 'u_jim_doe', 'u_jane_doe'))
      for (const n of ['e1', 'e2', 'e3']) await s.insert(llm(`case_${n}`, { reportId: `rpt_${n}` }))
    })
    expect(await inTenant(A, (s) => s.eraseAccount(A, 'u_john_doe', 'erased_ers_1'))).toBe(2)
    expect(await inTenant(A, (s) => s.findScreening(A, 'rpt_e1'))).toMatchObject({ reportedExternalId: 'erased_ers_1', reporterExternalId: 'u_jane_doe' })
    expect(await inTenant(A, (s) => s.findScreening(A, 'rpt_e2'))).toMatchObject({ reportedExternalId: 'u_jim_doe', reporterExternalId: 'erased_ers_1' })
    const summaries = await inTenant(A, async (s) => [(await s.find(A, 'case_e1'))?.summary, (await s.find(A, 'case_e2'))?.summary, (await s.find(A, 'case_e3'))?.summary])
    expect(summaries).toEqual([null, null, 'The reported account asked for $200.'])
    expect(await inTenant(A, (s) => s.eraseAccount(A, 'u_john_doe', 'erased_ers_1'))).toBe(0)
  })

  it('keeps tenants apart', async () => {
    const B = { ...A, appId: 'app_b' }
    expect(await inTenant(B, (s) => s.find(A, 'case_1'))).toBeNull()
    await expect(inTenant(B, (s) => s.insert(llm('case_x')))).rejects.toThrow()
  })
})
