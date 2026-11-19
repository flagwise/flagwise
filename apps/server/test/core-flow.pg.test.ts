// The core loop's services on Postgres: tenant transactions of their own, the Postgres bus and
// row-level security; a fixed classifier stands in for classify.
// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type TenantRef } from '@flagwise/kernel'
import { eventContract } from '@flagwise/contracts'
import { createDatabase, createPgBus, migrate, pgUnitOfWork, scopeOfRef, withTenant, type Database, type PgBus } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { casesMigrations, casesTables, pgCaseRepository, pgCasesPolicyCopy } from '@flagwise/cases'
import { deliveryMigrations, deliveryTables, pgActionRequestStore, pgDeliveryDeps } from '@flagwise/delivery'
import { schemaDrift } from '@flagwise/platform/testing'
import { pgTriageDeps, triageMigrations, triageTables } from '@flagwise/triage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composeServices, policyWithKeys, type Classification, type Services } from './support/services.ts'

const A: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const B: TenantRef = { orgId: 'org_1', appId: 'app_b', livemode: true }
const T0 = new Date('2026-11-05T09:00:00.000Z')
const H = 3_600_000
const CATEGORY = 'scams_fraud.romance_scam'

describe.skipIf(!testDatabaseUrl)('core flow on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  let flow: Services
  let n: number

  const caseOf = (tenant: TenantRef, id: string) => withTenant(db, scopeOfRef(tenant), (tx) => pgCaseRepository(tx).findById(tenant, id))
  const casesOf = (tenant: TenantRef, subject: string) => withTenant(db, scopeOfRef(tenant), (tx) => pgCaseRepository(tx).findBySubject(tenant, subject))
  const requestsOf = (tenant: TenantRef, decisionId: string) =>
    withTenant(db, scopeOfRef(tenant), (tx) => pgActionRequestStore(tx).findByDecision(tenant, decisionId))
  const types = async () => (await bus.log()).map((l) => l.event.type)
  const report = (reportId: string, tenant = A, subjectExternalId = 'u_jane_doe') => ({ tenant, reportId, subjectExternalId, p0Signal: false })
  const decideInput = (caseId: string, actionKeys: string[]) => ({
    tenant: A,
    caseId,
    memberId: 'mem_jane',
    outcome: 'violation' as const,
    categoryId: CATEGORY,
    severity: 'P1' as const,
    actionKeys,
  })
  const toDecision = async (actionKeys: string[]) => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    const [opened] = await casesOf(A, 'u_jane_doe')
    await flow.claim({ tenant: A, caseId: opened!.id, memberId: 'mem_jane' })
    const decision = await flow.decide(decideInput(opened!.id, actionKeys))
    await flow.drain()
    return { caseId: opened!.id, decision, requests: await requestsOf(A, decision.id) }
  }

  beforeEach(async () => {
    n = 0
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [casesMigrations, deliveryMigrations, triageMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { retryDelayMs: () => 0, contract: eventContract })
    const classification: Classification = { categoryId: CATEGORY, signals: [], injectionSuspected: false, preRuleP0: false, classifiedBy: 'llm' }
    const policy = pgCasesPolicyCopy(db)
    for (const tenant of [A, B]) await policy.keep(tenant, 1, policyWithKeys('warn', 'suspend_7d', 'hide_content'))
    const clock = manualClock(T0)
    flow = composeServices({
      bus,
      clock,
      newCaseId: () => `case_${++n}`,
      newDecisionId: () => `dec_${++n}`,
      newActionRequestId: () => `acr_${++n}`,
      newEventId: () => `evt_${++n}`,
      cases: { uow: pgUnitOfWork(db, bus, (tx) => ({ cases: pgCaseRepository(tx) })), policy },
      delivery: pgDeliveryDeps(db, bus, { clock, newActionRequestId: () => `acr_${++n}`, newEventId: () => `evt_${++n}` }),
      triage: pgTriageDeps(db, bus),
      classify: async () => classification,
    })
    await flow.drain()
  })
  afterEach(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, [...deliveryTables, ...casesTables, ...triageTables])).toEqual([])
  })

  it('takes a report to an open, triaged case', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    const [opened] = await casesOf(A, 'u_jane_doe')
    expect(opened).toMatchObject({
      state: 'open',
      reportIds: ['rpt_1'],
      triage: { severity: 'P1', priority: 2000, slaDueAt: new Date(T0.getTime() + 24 * H), suggestedActionKeys: [] },
    })
    expect(await types()).toEqual(['report.received.v1', 'case.opened.v1', 'case.classified.v1', 'case.triaged.v1'])
    expect((await bus.log()).every((l) => l.event.tenant?.appId === 'app_a')).toBe(true)
    expect(await bus.deadLetters()).toEqual([])
  })

  it('goes from decision to actioned, publishing "all confirmed" once for confirmations at once', async () => {
    const { caseId, requests } = await toDecision(['suspend_7d', 'hide_content'])
    expect(requests.map((r) => [r.actionKey, r.status])).toEqual([
      ['suspend_7d', 'pending'],
      ['hide_content', 'pending'],
    ])
    expect((await caseOf(A, caseId))?.state).toBe('decided')
    await Promise.all(requests.map((r) => flow.confirmAction(A, r.id)))
    await flow.drain()
    expect((await types()).filter((x) => x === 'decision.actions_confirmed.v1')).toHaveLength(1)
    expect((await caseOf(A, caseId))?.state).toBe('actioned')
    expect(await bus.deadLetters()).toEqual([])
  })

  it('records a failed action', async () => {
    const { caseId, requests } = await toDecision(['suspend_7d'])
    await flow.failAction(A, requests[0]!.id, 'user not found')
    await flow.drain()
    expect((await caseOf(A, caseId))?.state).toBe('action_failed')
    expect((await requestsOf(A, requests[0]!.decisionId))[0]).toMatchObject({ status: 'failed', failReason: 'user not found' })
    await expect(flow.confirmAction(A, 'acr_nope')).rejects.toThrow('No action request acr_nope')
  })

  it('is safe to replay every group', async () => {
    const { caseId, decision } = await toDecision(['warn'])
    const before = { record: await caseOf(A, caseId), requests: await requestsOf(A, decision.id), log: (await bus.log()).length }
    for (const group of ['cases.intake', 'classify', 'triage', 'cases.triage', 'delivery', 'cases.actions']) await bus.replay(group)
    await flow.drain()
    expect(await caseOf(A, caseId)).toEqual(before.record)
    expect(await requestsOf(A, decision.id)).toEqual(before.requests)
    expect((await bus.log()).length).toBe(before.log)
    expect(await bus.deadLetters()).toEqual([])
  })

  it('keeps tenants apart', async () => {
    await flow.submitReport(report('rpt_1', A))
    await flow.submitReport(report('rpt_2', B))
    await flow.drain()
    const [ofA] = await casesOf(A, 'u_jane_doe')
    const [ofB] = await casesOf(B, 'u_jane_doe')
    expect(ofA?.reportIds).toEqual(['rpt_1'])
    expect(ofB?.reportIds).toEqual(['rpt_2'])
    expect(await caseOf(B, ofA!.id)).toBeNull()
  })

  it('rolls back a run that throws: no writes, no events', async () => {
    const before = (await bus.log()).length
    const uow = pgUnitOfWork(db, bus, (tx) => ({ cases: pgCaseRepository(tx) }))
    await expect(
      uow.run(A, async (w) => {
        await w.stores.cases.insert({ id: 'case_x', tenant: A, subjectExternalId: 'u_john_doe', band: 'standard', state: 'classifying', reportIds: ['rpt_x'], openedAt: T0 })
        await w.publish({ id: 'evt_x', type: 'case.opened.v1', key: 'case_x', data: { caseId: 'case_x', reportId: 'rpt_x', subjectExternalId: 'u_john_doe', band: 'standard', occurredAt: T0 } })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await caseOf(A, 'case_x')).toBeNull()
    expect((await bus.log()).length).toBe(before)
  })
})
