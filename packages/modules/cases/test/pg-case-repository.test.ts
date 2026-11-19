// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, withTenant, type Database, type TenantScope } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CASE_STATES,
  casesMigrations,
  casesTables,
  claimCase,
  decideCase,
  pgCaseRepository,
  receiveReport,
  type CaseRecord,
  type CaseRepository,
} from '../src/index.ts'
import { RecordingPublisher } from './fakes.ts'

const A: TenantRef = { orgId: 'org_a', appId: 'app_a', livemode: true }
const B: TenantRef = { orgId: 'org_a', appId: 'app_b', livemode: true }
const scope = (t: TenantRef): TenantScope => ({ orgId: t.orgId, appIds: [t.appId], livemode: t.livemode })
const T0 = new Date('2026-11-03T09:00:00.000Z')

const base = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  id: 'case_1',
  tenant: A,
  subjectExternalId: 'u_jane_doe',
  band: 'standard',
  state: 'classifying',
  reportIds: ['rpt_1'],
  openedAt: T0,
  ...over,
})
const full = (): CaseRecord =>
  base({
    id: 'case_full',
    state: 'decided',
    reportIds: ['rpt_f1', 'rpt_f2'],
    claim: { memberId: 'mem_jane', claimedAt: new Date(T0.getTime() + 1000), lastActivityAt: new Date(T0.getTime() + 2000) },
    triage: { severity: 'P1', priority: 2030, slaDueAt: new Date(T0.getTime() + 86_400_000), suggestedActionKeys: ['warn', 'suspend_7d'] },
    decision: {
      id: 'dec_1',
      outcome: 'violation',
      categoryId: 'scams_fraud.romance_scam',
      severity: 'P1',
      actionKeys: ['suspend_7d'],
      decidedBy: 'mem_jane',
      decidedAt: new Date(T0.getTime() + 3000),
      reportIds: ['rpt_f1'],
      publicReason: 'Asked for money after two days',
    },
  })

describe.skipIf(!testDatabaseUrl)('pgCaseRepository', () => {
  let t: TestDatabase
  let db: Database
  const inTx = <R>(tenant: TenantRef, fn: (repo: CaseRepository) => Promise<R>) => withTenant(db, scope(tenant), (tx) => fn(pgCaseRepository(tx)))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [casesMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, casesTables)).toEqual([])
  })

  it('reads back what it wrote', async () => {
    await inTx(A, (r) => r.insert(full()))
    expect(await inTx(A, (r) => r.findById(A, 'case_full'))).toEqual(full())
    await inTx(A, (r) => r.insert(base()))
    expect(await inTx(A, (r) => r.findById(A, 'case_1'))).toEqual({ ...base(), claim: null, triage: null, decision: null })
  })

  it('finds by subject in order of opening, and by report id', async () => {
    await inTx(A, (r) => r.insert(base({ id: 'case_0', reportIds: ['rpt_0'], openedAt: new Date(T0.getTime() - 60_000), state: 'closed' })))
    const bySubject = await inTx(A, (r) => r.findBySubject(A, 'u_jane_doe'))
    expect(bySubject.map((c) => c.id)).toEqual(['case_0', 'case_1', 'case_full'])
    expect((await inTx(A, (r) => r.findByReportId(A, 'rpt_f2')))?.id).toBe('case_full')
    expect(await inTx(A, (r) => r.findByReportId(A, 'rpt_none'))).toBeNull()
  })

  it('keeps tenants apart, through the filters and through row-level security alone', async () => {
    expect(await inTx(B, (r) => r.findById(B, 'case_1'))).toBeNull()
    expect(await inTx(B, (r) => r.findBySubject(B, 'u_jane_doe'))).toEqual([])
    // Asking for tenant A inside a transaction scoped to B: row-level security still hides it.
    expect(await inTx(B, (r) => r.findById(A, 'case_1'))).toBeNull()
    await expect(inTx(B, (r) => r.insert(base({ id: 'case_x', reportIds: ['rpt_x'] })))).rejects.toThrow()
  })

  it('changes a case only when the condition holds', async () => {
    const claim = { memberId: 'mem_john', claimedAt: T0, lastActivityAt: T0 }
    // case_1 is classifying: a condition on another state changes nothing.
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['open'] }, { state: 'claimed', claim }))).toBe(false)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['classifying'] }, { state: 'open', triage: full().triage! }))).toBe(true)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['open'], claimedBy: null }, { state: 'claimed', claim }))).toBe(true)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['claimed'], claimedBy: null }, { claim: { ...claim, memberId: 'mem_jane' } }))).toBe(false)
    expect(await inTx(A, (r) => r.change(A, 'case_missing', { states: ['claimed'] }, { claim: null }))).toBe(false)
    expect(await inTx(A, (r) => r.findById(A, 'case_1'))).toMatchObject({ state: 'claimed', claim, triage: full().triage, reportIds: ['rpt_1'] })
  })

  it('checks an idle claim and the decision id, and saves a decision once', async () => {
    const idle = new Date(T0.getTime() + 1000)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['claimed'], claimedBy: 'mem_john', claimIdleSince: new Date(T0.getTime() - 1) }, { claim: null }))).toBe(false)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['claimed'], claimedBy: 'mem_john', claimIdleSince: idle }, { claim: { memberId: 'mem_jane', claimedAt: idle, lastActivityAt: idle } }))).toBe(true)
    const decision = { ...full().decision!, id: 'dec_2', internalNote: 'Repeat offender' }
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['claimed'], claimedBy: 'mem_jane' }, { state: 'decided', claim: null, decision }))).toBe(true)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['decided'], decisionId: 'dec_other' }, { state: 'actioned' }))).toBe(false)
    expect(await inTx(A, (r) => r.change(A, 'case_1', { states: ['decided'], decisionId: 'dec_2' }, { state: 'action_failed' }))).toBe(true)
    const got = (await inTx(A, (r) => r.findById(A, 'case_1')))!
    expect(got).toMatchObject({ state: 'action_failed', claim: null })
    expect(got.decision).toEqual(decision)
    await expect(inTx(A, (r) => r.change(A, 'case_1', { states: ['action_failed'] }, {}))).rejects.toThrow(TypeError)
  })

  it('attaches a report only while the case is in an accepting state, and never to two cases', async () => {
    expect(await inTx(A, (r) => r.attachReport(A, 'case_0', 'rpt_late', ['classifying', 'open']))).toBe(false)
    expect(await inTx(A, (r) => r.attachReport(A, 'case_full', 'rpt_f3', ['decided']))).toBe(true)
    expect((await inTx(A, (r) => r.findById(A, 'case_full')))?.reportIds).toEqual(['rpt_f1', 'rpt_f2', 'rpt_f3'])
    await expect(inTx(A, (r) => r.insert(base({ id: 'case_dup', reportIds: ['rpt_f1'] })))).rejects.toThrow()
    await expect(inTx(A, (r) => r.attachReport(A, 'case_full', 'rpt_1', ['decided']))).rejects.toThrow()
    expect(await inTx(B, (r) => r.attachReport(A, 'case_full', 'rpt_b', ['decided']))).toBe(false)
  })

  it('makes a state change wait for a report being attached', async () => {
    await inTx(A, (r) => r.insert(base({ id: 'case_w', reportIds: ['rpt_w1'], state: 'open' })))
    const order: string[] = []
    let attached!: () => void
    const attachedNow = new Promise<void>((res) => (attached = res))
    let release!: () => void
    const held = new Promise<void>((res) => (release = res))
    const attach = inTx(A, async (r) => {
      const ok = await r.attachReport(A, 'case_w', 'rpt_w2', ['open'])
      attached()
      await held
      order.push('attach committed')
      return ok
    })
    await attachedNow
    const change = inTx(A, async (r) => {
      const ok = await r.change(A, 'case_w', { states: ['open'] }, { state: 'claimed', claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 } })
      order.push('change done')
      return ok
    })
    await new Promise((res) => setTimeout(res, 100))
    release()
    expect(await Promise.all([attach, change])).toEqual([true, true])
    expect(order).toEqual(['attach committed', 'change done'])
  })

  it('opens one case when several first reports about an account arrive at once', async () => {
    let n = 0
    // Each transaction waits after reading the subject's cases until all three have read them, or
    // 200 ms: without the lock all three would see no case and open one each.
    let arrived = 0
    const together = () =>
      new Promise<void>((resolve) => {
        arrived++
        const check = setInterval(() => (arrived >= 3 ? done() : undefined), 5)
        const timer = setTimeout(() => done(), 200)
        const done = () => (clearInterval(check), clearTimeout(timer), resolve())
      })
    const racing = (repo: CaseRepository): CaseRepository => ({
      ...repo,
      findBySubject: async (t, s) => {
        const found = await repo.findBySubject(t, s)
        await together()
        return found
      },
    })
    const deps = (repo: CaseRepository) => ({ cases: racing(repo), events: new RecordingPublisher(), clock: manualClock('2026-11-04T09:00:00Z'), newCaseId: () => `case_p${++n}` })
    const report = (reportId: string) => ({ tenant: A, reportId, subjectExternalId: 'u_jane_doe_2', p0Signal: false })
    const results = await Promise.all(['rpt_p1', 'rpt_p2', 'rpt_p3'].map((id) => inTx(A, (r) => receiveReport(deps(r), report(id)))))
    expect(results.filter((r) => !r.joinedExistingCase)).toHaveLength(1)
    const opened = await inTx(A, (r) => r.findBySubject(A, 'u_jane_doe_2'))
    expect(opened).toHaveLength(1)
    expect([...opened[0]!.reportIds].sort()).toEqual(['rpt_p1', 'rpt_p2', 'rpt_p3'])
  })

  it('runs the cases use cases on Postgres', async () => {
    const clock = manualClock('2026-11-04T09:00:00Z')
    const events = new RecordingPublisher()
    let n = 0
    const deps = (repo: CaseRepository) => ({
      cases: repo,
      events,
      clock,
      newCaseId: () => `case_u${++n}`,
      newDecisionId: () => `dec_u${n}`,
      catalog: { allowedActionKeys: async () => ['warn', 'suspend_7d'] },
    })
    const report = (reportId: string) => ({ tenant: A, reportId, subjectExternalId: 'u_john_doe', p0Signal: false })

    const first = await inTx(A, (r) => receiveReport(deps(r), report('rpt_u1')))
    expect(first).toEqual({ caseId: 'case_u1', joinedExistingCase: false, duplicate: false })
    expect(await inTx(A, (r) => receiveReport(deps(r), report('rpt_u1')))).toMatchObject({ duplicate: true })
    // Two reports join the same case in parallel transactions; the subject lock makes them take turns.
    await Promise.all([inTx(A, (r) => receiveReport(deps(r), report('rpt_u2'))), inTx(A, (r) => receiveReport(deps(r), report('rpt_u3')))])
    const opened = (await inTx(A, (r) => r.findById(A, 'case_u1')))!
    expect([...opened.reportIds].sort()).toEqual(['rpt_u1', 'rpt_u2', 'rpt_u3'])

    await inTx(A, (r) => r.change(A, 'case_u1', { states: ['classifying'] }, { state: 'open' }))
    await inTx(A, (r) => claimCase(deps(r), { tenant: A, caseId: 'case_u1', memberId: 'mem_jane' }))
    const decision = await inTx(A, (r) =>
      decideCase(deps(r), { tenant: A, caseId: 'case_u1', memberId: 'mem_jane', outcome: 'violation', categoryId: 'scams_fraud.romance_scam', severity: 'P1', actionKeys: ['warn'] }),
    )
    expect(await inTx(A, (r) => r.findById(A, 'case_u1'))).toMatchObject({ state: 'decided', claim: null, decision })
    expect(events.events.map((e) => e.type)).toEqual([
      'case.opened',
      'case.report_attached',
      'case.report_attached',
      'case.claimed',
      'case.decided',
    ])
  })
})

describe.skipIf(!testDatabaseUrl)('pgCaseRepository queue', () => {
  let t: TestDatabase
  let db: Database
  const inTx = <R>(tenant: TenantRef, fn: (repo: ReturnType<typeof pgCaseRepository>) => Promise<R>) =>
    withTenant(db, scope(tenant), (tx) => fn(pgCaseRepository(tx)))
  const NOW = new Date(T0.getTime() + 3 * 3_600_000)
  const triaged = (id: string, priority: number, dueInHours: number, over: Partial<CaseRecord> = {}): CaseRecord =>
    base({
      id,
      state: 'open',
      reportIds: [`rpt_${id}`],
      triage: { severity: priority >= 3000 ? 'P0' : 'P2', priority, slaDueAt: new Date(T0.getTime() + dueInHours * 3_600_000), suggestedActionKeys: [] },
      classification: { categoryId: 'scams_fraud.romance_scam', signals: ['asking_for_money'], injectionSuspected: false, classifiedBy: 'llm' },
      ...over,
    })
  const ids = (page: { data: readonly CaseRecord[] }) => page.data.map((r) => r.id)

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [casesMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    await inTx(A, async (repo) => {
      await repo.insert(triaged('case_p2_late', 1000, 48))
      await repo.insert(triaged('case_p2_soon', 1000, 2))
      await repo.insert(triaged('case_p0', 3000, 1, { classification: { categoryId: 'child_safety.grooming', signals: ['minor_involved'], injectionSuspected: true, classifiedBy: 'rules' } }))
      await repo.insert(triaged('case_claimed', 1000, 24, { state: 'claimed', claim: { memberId: 'key_jane', claimedAt: T0, lastActivityAt: T0 } }))
      await repo.insert(base({ id: 'case_untriaged', state: 'untriaged', reportIds: ['rpt_u'] }))
      await repo.insert(base({ id: 'case_classifying', state: 'classifying', reportIds: ['rpt_c'] }))
      await repo.insert(triaged('case_closed', 5000, 1, { state: 'closed' }))
    })
    await inTx(B, (repo) => repo.insert(triaged('case_other_app', 9000, 1, { tenant: B })))
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('reads back the classification facts, and leaves them out until set', async () => {
    const p0 = await inTx(A, (repo) => repo.findById(A, 'case_p0'))
    expect(p0?.classification).toEqual({ categoryId: 'child_safety.grooming', signals: ['minor_involved'], injectionSuspected: true, classifiedBy: 'rules' })
    expect(await inTx(A, (repo) => repo.findById(A, 'case_untriaged'))).not.toHaveProperty('classification')
  })

  it('lists the queue states by default, most urgent first, untriaged last, only for the tenant', async () => {
    expect(ids(await inTx(A, (repo) => repo.list(A, { now: NOW })))).toEqual(['case_p0', 'case_p2_soon', 'case_claimed', 'case_p2_late', 'case_untriaged'])
  })

  it('filters by state, severity, category, claim holder and SLA', async () => {
    const list = (q: Omit<Parameters<ReturnType<typeof pgCaseRepository>['list']>[1], 'now'>) => inTx(A, (repo) => repo.list(A, { now: NOW, ...q })).then(ids)
    expect(await list({ states: ['closed', 'classifying'] })).toEqual(['case_closed', 'case_classifying'])
    expect(await list({ severities: ['P0'] })).toEqual(['case_p0'])
    expect(await list({ categoryIds: ['child_safety.grooming'] })).toEqual(['case_p0'])
    expect(await list({ claimedBy: 'key_jane' })).toEqual(['case_claimed'])
    expect(await list({ claimedBy: null })).toEqual(['case_p0', 'case_p2_soon', 'case_p2_late', 'case_untriaged'])
    expect(await list({ slaBreached: true })).toEqual(['case_p0', 'case_p2_soon'])
    expect(await list({ slaBreached: false })).toEqual(['case_claimed', 'case_p2_late', 'case_untriaged'])
  })

  it('pages with a cursor, without repeats or gaps, and refuses a bad cursor or limit', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await inTx(A, (repo) => repo.list(A, { now: NOW, limit: 2, ...(cursor && { cursor }) }))
      seen.push(...ids(page))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['case_p0', 'case_p2_soon', 'case_claimed', 'case_p2_late', 'case_untriaged'])
    await expect(inTx(A, (repo) => repo.list(A, { now: NOW, cursor: 'bm9wZQ' }))).rejects.toThrow(RangeError)
    await expect(inTx(A, (repo) => repo.list(A, { now: NOW, limit: 101 }))).rejects.toThrow(RangeError)
  })
})

describe.skipIf(!testDatabaseUrl)('pgCaseRepository report facts and account history', () => {
  let t: TestDatabase
  let db: Database
  const inTx = <R>(tenant: TenantRef, fn: (repo: ReturnType<typeof pgCaseRepository>) => Promise<R>) =>
    withTenant(db, scope(tenant), (tx) => fn(pgCaseRepository(tx)))
  const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000)
  const john = (id: string, hours: number, state: CaseRecord['state']): CaseRecord =>
    base({ id, subjectExternalId: 'u_john_doe', state, reportIds: [`rpt_${id}`], openedAt: at(hours) })

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [casesMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    await inTx(A, async (repo) => {
      await repo.insert(john('case_j1', 0, 'closed'))
      await repo.insert(john('case_j2', 1, 'actioned'))
      await repo.insert(john('case_j3', 2, 'open'))
      await repo.insert(john('case_j3b', 2, 'decided'))
      await repo.insert(base({ id: 'case_jane', reportIds: ['rpt_jane'], openedAt: at(5), state: 'open' }))
    })
    await inTx(B, (repo) => repo.insert({ ...john('case_j_other_app', 9, 'open'), tenant: B }))
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it("reads back a triage's rules and flags, and leaves them out when not kept", async () => {
    const triage = { severity: 'P2' as const, priority: 1120, slaDueAt: at(72), suggestedActionKeys: [], applied: ['reported_new_account'], flags: ['injection_suspected'] }
    await inTx(A, (repo) => repo.change(A, 'case_j3', { states: ['open'] }, { triage }))
    expect((await inTx(A, (repo) => repo.findById(A, 'case_j3')))?.triage).toEqual(triage)
    const { applied: _a, flags: _f, ...older } = triage
    await inTx(A, (repo) => repo.change(A, 'case_j3', { states: ['open'] }, { triage: older }))
    expect((await inTx(A, (repo) => repo.findById(A, 'case_j3')))?.triage).toEqual(older)
  })

  it("lists an account's cases latest first, page by page, and refuses a cursor of the other order", async () => {
    const every = CASE_STATES
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await inTx(A, (repo) => repo.list(A, { now: at(10), states: every, subjectExternalId: 'u_john_doe', order: 'recent', limit: 1, ...(cursor && { cursor }) }))
      seen.push(...page.data.map((c) => c.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['case_j3b', 'case_j3', 'case_j2', 'case_j1'])

    const urgent = await inTx(A, (repo) => repo.list(A, { now: at(10), states: every, limit: 1 }))
    await expect(inTx(A, (repo) => repo.list(A, { now: at(10), order: 'recent', cursor: urgent.nextCursor! }))).rejects.toThrow(RangeError)
    await expect(inTx(A, (repo) => repo.list(A, { now: at(10), cursor: cursor! }))).rejects.toThrow(RangeError)
  })
})

describe.skipIf(!testDatabaseUrl)('pgCaseRepository erasure', () => {
  let t: TestDatabase
  let db: Database
  const inTx = <R>(tenant: TenantRef, fn: (repo: CaseRepository) => Promise<R>) => withTenant(db, scope(tenant), (tx) => fn(pgCaseRepository(tx)))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [casesMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it("tombstones the account's cases, drops their decisions' free text, and keeps other accounts' cases", async () => {
    await inTx(A, async (repo) => {
      await repo.insert({ ...full(), subjectExternalId: 'u_john_doe' })
      await repo.insert(base({ id: 'case_other', subjectExternalId: 'u_jim_doe', reportIds: ['rpt_o1'] }))
    })
    await inTx(B, (repo) => repo.insert(base({ id: 'case_b', tenant: B, subjectExternalId: 'u_john_doe', reportIds: ['rpt_b1'] })))
    expect(await inTx(A, (repo) => repo.eraseAccount(A, 'u_john_doe', 'erased_ers_1'))).toBe(1)
    const erased = await inTx(A, (repo) => repo.findById(A, 'case_full'))
    expect(erased).toMatchObject({ subjectExternalId: 'erased_ers_1', state: 'decided', decision: { id: 'dec_1', categoryId: 'scams_fraud.romance_scam', severity: 'P1' } })
    expect(erased?.decision?.publicReason ?? null).toBeNull()
    expect(await inTx(A, (repo) => repo.findBySubject(A, 'u_john_doe'))).toEqual([])
    expect((await inTx(A, (repo) => repo.findById(A, 'case_other')))?.subjectExternalId).toBe('u_jim_doe')
    expect((await inTx(B, (repo) => repo.findById(B, 'case_b')))?.subjectExternalId).toBe('u_john_doe')
    expect(await inTx(A, (repo) => repo.eraseAccount(A, 'u_john_doe', 'erased_ers_1'))).toBe(0)
  })
})
