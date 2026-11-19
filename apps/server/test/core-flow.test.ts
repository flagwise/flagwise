// The core loop's services on one in-memory bus: moderation, triage and delivery react to each
// other's facts, each on its own unit of work; a fixed classifier stands in for classify.
import { manualClock, type ManualClock, type AppRef } from '@flagwise/kernel'
import { eventContract } from '@flagwise/contracts'
import { createMemoryBus, memoryDocumentCopy, memoryUnitOfWork, type MemoryBus } from '@flagwise/platform'
import type { CaseRecord, CaseRepository } from '@flagwise/moderation'
import type { ActionRequest, ActionRequestStore, StoredEvent, StoredSecret, WebhookEndpoint, WebhookStore } from '@flagwise/delivery'
import type { Policy } from '@flagwise/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { composeServices, MemoryTriageCases, policyWithKeys, type Classification, type Services } from './support/services.ts'

const appRef: AppRef = { appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-03T09:00:00.000Z')
const H = 3_600_000
const same = (a: AppRef, b: AppRef) => a.appId === b.appId && a.livemode === b.livemode

class Cases implements CaseRepository {
  readonly rows = new Map<string, CaseRecord>()
  async findById(t: AppRef, id: string) {
    const r = this.rows.get(id)
    return r && same(r.appRef, t) ? structuredClone(r) : null
  }
  async findBySubject(t: AppRef, s: string) {
    return [...this.rows.values()].filter((r) => same(r.appRef, t) && r.subjectExternalId === s).map((r) => structuredClone(r))
  }
  async findByReportId(t: AppRef, rid: string) {
    const r = [...this.rows.values()].find((c) => same(c.appRef, t) && c.reportIds.includes(rid))
    return r ? structuredClone(r) : null
  }
  async lockSubject() {}
  async eraseAccount(t: AppRef, externalId: string, erasedId: string) {
    let n = 0
    for (const [id, r] of this.rows) if (same(r.appRef, t) && r.subjectExternalId === externalId) (this.rows.set(id, { ...r, subjectExternalId: erasedId }), n++)
    return n
  }
  async insert(r: CaseRecord) {
    this.rows.set(r.id, structuredClone(r))
  }
  async change(t: AppRef, id: string, c: Parameters<CaseRepository['change']>[2], ch: Parameters<CaseRepository['change']>[3]) {
    const r = this.rows.get(id)
    if (!r || !same(r.appRef, t) || !c.states.includes(r.state)) return false
    if (c.claimedBy === null && r.claim) return false
    if (typeof c.claimedBy === 'string' && r.claim?.memberId !== c.claimedBy) return false
    if (c.claimIdleSince && !(r.claim && r.claim.lastActivityAt <= c.claimIdleSince)) return false
    if (c.decisionId !== undefined && r.decision?.id !== c.decisionId) return false
    this.rows.set(id, { ...r, ...structuredClone(ch) })
    return true
  }
  async attachReport(t: AppRef, id: string, reportId: string, states: Parameters<CaseRepository['attachReport']>[3]) {
    const r = this.rows.get(id)
    if (!r || !same(r.appRef, t) || !states.includes(r.state)) return false
    this.rows.set(id, { ...r, reportIds: [...r.reportIds, reportId] })
    return true
  }
  readonly failures = new Map<string, { caseId: string; answered: boolean }>()
  async addActionFailure(_t: AppRef, caseId: string, id: string) {
    if (this.failures.has(id)) return false
    this.failures.set(id, { caseId, answered: false })
    return true
  }
  async openActionFailures(_t: AppRef, caseId: string) {
    return [...this.failures].filter(([, f]) => f.caseId === caseId && !f.answered).map(([id]) => id)
  }
  async answerActionFailures(_t: AppRef, _caseId: string, ids: readonly string[]) {
    for (const id of ids) this.failures.get(id)!.answered = true
  }
}

class Requests implements ActionRequestStore {
  readonly rows = new Map<string, ActionRequest>()
  async findById(t: AppRef, id: string) {
    const r = this.rows.get(id)
    return r && same(r.appRef, t) ? structuredClone(r) : null
  }
  async findByDecision(t: AppRef, d: string) {
    return [...this.rows.values()].filter((r) => same(r.appRef, t) && r.decisionId === d).map((r) => structuredClone(r))
  }
  async lockDecision() {}
  async insert(r: ActionRequest) {
    this.rows.set(r.id, structuredClone(r))
  }
  async update(r: ActionRequest) {
    this.rows.set(r.id, structuredClone(r))
  }
}

/** Only what the flow's webhook fan-out uses: one endpoint taking every type, events and deliveries. */
class Webhooks implements WebhookStore {
  readonly events = new Map<string, StoredEvent>()
  readonly deliveries: { eventId: string; endpointId: string }[] = []
  endpointsOf: WebhookEndpoint[] = [{ id: 'whe_1', appRef, url: 'https://hooks.example.com', eventTypes: null, createdAt: T0 }]
  async lockApp() {}
  async eraseAccount() {
    return 0
  }
  async secrets(): Promise<StoredSecret[]> {
    return []
  }
  async insertSecret() {}
  async expireSecretsBy() {}
  async endpoints(t: AppRef) {
    return this.endpointsOf.filter((e) => same(e.appRef, t))
  }
  async insertEndpoint() {}
  async deleteEndpoint() {
    return false
  }
  async insertEvent(_t: AppRef, e: StoredEvent) {
    if (!this.events.has(e.sourceId)) this.events.set(e.sourceId, e)
    return this.events.get(e.sourceId)!
  }
  async insertDelivery(_t: AppRef, d: { eventId: string; endpointId: string }) {
    if (!this.deliveries.some((x) => x.eventId === d.eventId && x.endpointId === d.endpointId)) this.deliveries.push({ eventId: d.eventId, endpointId: d.endpointId })
  }
  bodies() {
    return [...this.events.values()].map((e) => JSON.parse(e.body) as { type: string; data: Record<string, unknown> })
  }
}

const POLICY: Policy = policyWithKeys('warn', 'suspend_7d', 'ban', 'hide_content')

let bus: MemoryBus
let cases: Cases
let requests: Requests
let webhooks: Webhooks
let triageCases: MemoryTriageCases
let clock: ManualClock
let flow: Services
let classifyCalls: string[]
let classification: Classification
let seq: Record<string, number>

beforeEach(async () => {
  bus = createMemoryBus({ contract: eventContract })
  cases = new Cases()
  requests = new Requests()
  webhooks = new Webhooks()
  triageCases = new MemoryTriageCases()
  clock = manualClock(T0)
  classifyCalls = []
  classification = { categoryId: 'scams_fraud.romance_scam', signals: [], injectionSuspected: false, preRuleP0: false, classifiedBy: 'llm' }
  seq = { case: 0, dec: 0, acr: 0, evt: 0 }
  const next = (p: string) => () => `${p}_${++seq[p]!}`
  const casesPolicy = memoryDocumentCopy<Policy>()
  for (const t of [appRef, { ...appRef, appId: 'app_b' }]) await casesPolicy.keep(t, 1, POLICY)
  flow = composeServices({
    bus,
    clock,
    newCaseId: next('case'),
    newDecisionId: next('dec'),
    newActionRequestId: next('acr'),
    newEventId: next('evt'),
    cases: { uow: memoryUnitOfWork(bus, { cases }), policy: casesPolicy },
    delivery: { uow: memoryUnitOfWork(bus, { requests, webhooks }) },
    triage: { uow: memoryUnitOfWork(bus, { cases: triageCases }), policy: memoryDocumentCopy<Policy>() },
    classify: async (_t, caseId) => (classifyCalls.push(caseId), classification),
  })
})

const report = (reportId: string, subjectExternalId = 'u_5531', p0Signal = false) => ({ appRef, reportId, subjectExternalId, p0Signal })
const decideInput = (actionKeys: string[], memberId = 'mem_jane') => ({
  appRef,
  caseId: 'case_1',
  memberId,
  outcome: 'violation' as const,
  categoryId: 'scams_fraud.romance_scam',
  severity: 'P1' as const,
  actionKeys,
})
const types = () => bus.log().map((l) => l.event.type)
const ACTION_FACTS = {
  decisionId: 'dec_1',
  subjectExternalId: 'u_5531',
  categoryId: 'scams_fraud.romance_scam',
  severity: 'P1',
  reason: 'decision',
  requestedBy: { type: 'member', id: 'mem_jane' },
}

describe('the core loop across services', () => {
  it('takes a report to an open, triaged case', async () => {
    await flow.submitReport(report('rpt_1'))
    expect(cases.rows.size).toBe(0)
    await flow.drain()
    expect(cases.rows.get('case_1')).toMatchObject({
      state: 'open',
      reportIds: ['rpt_1'],
      triage: { severity: 'P1', priority: 2000, slaDueAt: new Date(T0.getTime() + 24 * H), suggestedActionKeys: [] },
    })
    expect(types()).toEqual(['report.received.v1', 'case.opened.v1', 'case.classified.v1', 'case.triaged.v1'])
    expect(bus.log().map((l) => l.event.id)).toEqual([
      'report.received:rpt_1',
      'case.opened:case_1',
      'case.classified:case_1',
      'case.triaged:case_1',
    ])
    expect(bus.log()[0]?.event.key).toBe('rpt_1')
    expect(bus.log().slice(1).every((l) => l.event.key === 'case_1')).toBe(true)
    expect(bus.deadLetters()).toEqual([])
  })

  it('classifies a case once, however many reports join it', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.submitReport(report('rpt_2'))
    await flow.submitReport(report('rpt_3'))
    await flow.drain()
    expect(cases.rows.size).toBe(1)
    expect(cases.rows.get('case_1')?.reportIds).toEqual(['rpt_1', 'rpt_2', 'rpt_3'])
    expect(classifyCalls).toEqual(['case_1'])
    expect(types().filter((t) => t === 'case.report_attached.v1')).toHaveLength(2)
  })

  it("weighs the accounts' ages, counting each reporter once, and keeps triage's rules and flags", async () => {
    const days = (n: number) => new Date(T0.getTime() - n * 24 * H)
    const facts = (reporterExternalId: string, reporterAccountCreatedAt: Date | null) => ({ reporterExternalId, reporterAccountCreatedAt, reportedAccountCreatedAt: days(2) })
    // Reports joining before triage count; Jane's second report adds no second reporter.
    await flow.submitReport({ ...report('rpt_1'), facts: facts('u_jane_doe', days(400)) })
    await flow.submitReport({ ...report('rpt_2'), facts: facts('u_jane_doe', days(400)) })
    await flow.submitReport({ ...report('rpt_3'), facts: facts('u_jim_doe', new Date(T0.getTime() - H)) })
    await flow.drain()
    // P1 2000, a new reported account 100, reporters 1 + 0.5 (Jim's account is an hour old) times 20.
    expect(cases.rows.get('case_1')?.triage).toMatchObject({ severity: 'P1', priority: 2130, applied: ['reported_new_account', 'reporter_new_account'], flags: [] })
    expect(bus.log().find((l) => l.event.type === 'case.triaged.v1')?.event.data).toMatchObject({ applied: ['reported_new_account', 'reporter_new_account'], flags: [] })

    await flow.submitReport(report('rpt_4', 'u_jack_doe'))
    await flow.drain()
    expect(cases.rows.get('case_2')?.triage).toMatchObject({ priority: 2000, applied: [], flags: ['reported_age_unknown'] })
  })

  it('opens a separate P0 case and triages it as P0', async () => {
    classification = { ...classification, categoryId: 'child_safety.underage_user', signals: ['minor_involved'] }
    await flow.submitReport(report('rpt_1'))
    await flow.submitReport(report('rpt_2', 'u_5531', true))
    await flow.drain()
    expect(cases.rows.size).toBe(2)
    expect(cases.rows.get('case_2')).toMatchObject({ band: 'p0', state: 'open', triage: { severity: 'P0' } })
  })

  it('ignores a duplicate report', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    expect(cases.rows.get('case_1')?.reportIds).toEqual(['rpt_1'])
    expect(types().filter((t) => t === 'report.received.v1')).toHaveLength(1)
  })

  it('goes from decision to confirmed actions', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    clock.advance(H)
    const decision = await flow.decide(decideInput(['suspend_7d', 'hide_content']))
    expect(decision.id).toBe('dec_1')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('decided')
    expect([...requests.rows.values()]).toEqual([
      { id: 'acr_1', appRef, caseId: 'case_1', decisionId: 'dec_1', actionKey: 'suspend_7d', status: 'pending', failReason: null, retryId: null, replacedBy: null },
      { id: 'acr_2', appRef, caseId: 'case_1', decisionId: 'dec_1', actionKey: 'hide_content', status: 'pending', failReason: null, retryId: null, replacedBy: null },
    ])
    expect(bus.log().filter((l) => l.event.type === 'action.requested.v1').map((l) => l.event.data)).toEqual([
      { actionRequestId: 'acr_1', caseId: 'case_1', actionKey: 'suspend_7d', ...ACTION_FACTS },
      { actionRequestId: 'acr_2', caseId: 'case_1', actionKey: 'hide_content', ...ACTION_FACTS },
    ])

    await flow.confirmAction(appRef, 'acr_1')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('decided')
    await flow.confirmAction(appRef, 'acr_2')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('actioned')
    expect(bus.deadLetters()).toEqual([])
  })

  it('records a failed action, and a settled request does not change again', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await flow.decide(decideInput(['suspend_7d']))
    await flow.drain()
    await flow.failAction(appRef, 'acr_1', 'user not found')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('action_failed')
    expect(requests.rows.get('acr_1')).toMatchObject({ status: 'failed', failReason: 'user not found' })
    await flow.confirmAction(appRef, 'acr_1')
    await flow.failAction(appRef, 'acr_1', 'again')
    await flow.drain()
    expect(requests.rows.get('acr_1')?.status).toBe('failed')
    expect(types().filter((t) => t === 'action.failed.v1')).toHaveLength(1)
  })

  it('answers failed actions through delivery, and a failure the retry did not name waits for another answer', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await flow.decide(decideInput(['suspend_7d', 'hide_content']))
    await flow.drain()
    await flow.failAction(appRef, 'acr_1', 'user not found')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('action_failed')

    // The retry answers the failure moderation knows of; hide_content fails before delivery carries it out.
    await flow.retryActions({ appRef, caseId: 'case_1', memberId: 'mem_jane', actionKeys: ['ban'] })
    await flow.failAction(appRef, 'acr_2', 'timeout')
    await flow.drain()
    expect(requests.rows.get('acr_1')?.replacedBy).not.toBeNull()
    expect(requests.rows.get('acr_2')).toMatchObject({ status: 'failed', replacedBy: null })
    expect(requests.rows.get('acr_3')).toMatchObject({ actionKey: 'ban', status: 'pending' })
    expect(cases.rows.get('case_1')?.state).toBe('action_failed')

    // The second answer covers it; the replaced and answered failures do not count again.
    await flow.retryActions({ appRef, caseId: 'case_1', memberId: 'mem_jane', actionKeys: [] })
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('decided')
    bus.replay('cases.actions')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('decided')
    await flow.confirmAction(appRef, 'acr_3')
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('actioned')
    expect(bus.deadLetters()).toEqual([])
  })

  it('closes a decision without actions immediately', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await flow.decide(decideInput([]))
    await flow.drain()
    expect(cases.rows.get('case_1')?.state).toBe('actioned')
    expect(requests.rows.size).toBe(0)
  })

  it('is safe to replay: no duplicate requests, no second classification', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await flow.decide(decideInput(['warn']))
    await flow.drain()
    const before = { cases: structuredClone([...cases.rows.values()]), triage: structuredClone([...triageCases.rows.values()]), requests: requests.rows.size, log: bus.log().length }
    for (const group of ['cases.intake', 'triage', 'cases.triage', 'delivery', 'cases.actions']) bus.replay(group)
    await flow.drain()
    expect(requests.rows.size).toBe(before.requests)
    expect([...cases.rows.values()]).toEqual(before.cases)
    expect([...triageCases.rows.values()]).toEqual(before.triage)
    expect(bus.log().length).toBe(before.log)
    expect(classifyCalls).toEqual(['case_1'])
    expect(bus.deadLetters()).toEqual([])
  })

  it('refuses an unknown action request', async () => {
    await expect(flow.confirmAction(appRef, 'acr_nope')).rejects.toThrow(Error)
    await expect(flow.failAction(appRef, 'acr_nope', 'x')).rejects.toThrow(Error)
  })

  it('keeps appRefs apart', async () => {
    const other = { ...appRef, appId: 'app_b' }
    await flow.submitReport(report('rpt_1'))
    await flow.submitReport({ ...report('rpt_2'), appRef: other })
    await flow.drain()
    expect(cases.rows.size).toBe(2)
    expect(cases.rows.get('case_2')?.appRef).toEqual(other)
  })
})

describe('a correction across services', () => {
  it('saves the severity at once, then the priority and SLA triage gives from case.corrected, with no webhook', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    const saved = await flow.correct({ appRef, caseId: 'case_1', memberId: 'mem_jane', categoryId: 'spam.spam' })
    expect(saved).toMatchObject({ classification: { categoryId: 'spam.spam' }, triage: { severity: 'P2', priority: 2000 } })
    await flow.drain()
    expect(cases.rows.get('case_1')).toMatchObject({
      state: 'claimed',
      classification: { categoryId: 'spam.spam' },
      triage: { severity: 'P2', priority: 1000, slaDueAt: new Date(T0.getTime() + 72 * H) },
    })
    expect(types().slice(-2)).toEqual(['case.corrected.v2', 'case.triaged.v1'])
    expect([...webhooks.events.keys()]).toEqual(['case.triaged:case_1'])
  })

  it("leaves an older correction's triage for the newer one's", async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await flow.correct({ appRef, caseId: 'case_1', memberId: 'mem_jane', categoryId: 'spam.spam' })
    await flow.correct({ appRef, caseId: 'case_1', memberId: 'mem_jane', categoryId: 'child_safety.grooming' })
    await flow.drain()
    expect(cases.rows.get('case_1')).toMatchObject({ classification: { categoryId: 'child_safety.grooming' }, triage: { severity: 'P0', slaDueAt: new Date(T0.getTime() + H) } })
  })
})

describe('webhooks from the core loop', () => {
  it('queues report.triaged once per case, with its reports and classification and no summary', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    expect(webhooks.bodies()).toEqual([
      expect.objectContaining({
        type: 'report.triaged',
        data: {
          case_id: 'case_1',
          report_ids: ['rpt_1'],
          category_id: 'scams_fraud.romance_scam',
          custom_category_id: null,
          severity: 'P1',
          priority: 2000,
          sla_due_at: new Date(T0.getTime() + 24 * H).toISOString(),
          suggested_action_keys: [],
          signals: [],
          injection_suspected: false,
          classified_by: 'llm',
        },
      }),
    ])
    expect(webhooks.deliveries).toHaveLength(1)
    expect([...webhooks.events.keys()]).toEqual(['case.triaged:case_1'])
  })

  it('queues report.triaged again after the LLM answers only once moderation took the new triage', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    const first = bus.log().find((l) => l.event.type === 'case.triaged.v1')!.event
    // Triage's new triage after the LLM answered, as it publishes it.
    const retry = (id: string) => bus.publish({ ...first, id, data: { ...(first.data as object), categoryId: 'scams_fraud.investment_scam', cause: 'llm_retry' } })
    await retry('case.triaged:case_1:llm_retry')
    await flow.drain()
    expect(cases.rows.get('case_1')).toMatchObject({ classification: { categoryId: 'scams_fraud.investment_scam' } })
    expect([...webhooks.events.keys()]).toEqual(['case.triaged:case_1', 'case.retriaged:case.triaged:case_1:llm_retry'])
    expect(webhooks.bodies().at(-1)).toMatchObject({ type: 'report.triaged', data: { category_id: 'scams_fraud.investment_scam' } })

    // A moderator claims the case before moderation saves the next one: the case keeps its triage, and the tenant hears nothing.
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await retry('case.triaged:case_1:llm_retry:again')
    await flow.drain()
    expect(types().filter((t) => t === 'case.retriaged.v1')).toHaveLength(1)
    expect(webhooks.events.size).toBe(2)
  })

  it('queues one action.requested per action, naming who decided', async () => {
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    await flow.claim({ appRef, caseId: 'case_1', memberId: 'key_jane' })
    await flow.decide(decideInput(['suspend_7d'], 'key_jane'))
    await flow.drain()
    const requested = webhooks.bodies().filter((b) => b.type === 'action.requested')
    expect(requested.map((b) => b.data)).toEqual([
      {
        action_request_id: 'acr_1',
        action_key: 'suspend_7d',
        subject_external_id: 'u_5531',
        case_id: 'case_1',
        decision_id: 'dec_1',
        category_id: 'scams_fraud.romance_scam',
        severity: 'P1',
        reason: 'decision',
        requested_by: { type: 'api_key', id: 'key_jane' },
      },
    ])
  })

  it('queues nothing when the app has no endpoint', async () => {
    webhooks.endpointsOf = []
    await flow.submitReport(report('rpt_1'))
    await flow.drain()
    expect(webhooks.events.size).toBe(0)
    expect(bus.deadLetters()).toEqual([])
  })
})
