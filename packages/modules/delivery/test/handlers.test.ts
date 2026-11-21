// Delivery on an in-memory bus, alone: moderation's facts (a case decided or triaged) in, its
// action requests, the facts it publishes, its overdue timers and the webhooks it queues out.
import { eventContract, type EventData } from '@flagwise/contracts'
import { manualClock, type AppRef, type ManualClock } from '@flagwise/kernel'
import { createMemoryBus, memoryScheduler, memoryUnitOfWork, type MemoryBus } from '@flagwise/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { actionSettlement, subscribeDelivery, type ActionRequest, type ActionRequestStore, type ActionSettlement, type StoredEvent, type StoredSecret, type WebhookEndpoint, type WebhookStore } from '../src/index.ts'

const appRef: AppRef = { appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-21T09:00:00.000Z')
const H = 3_600_000
const same = (a: AppRef, b: AppRef) => a.appId === b.appId && a.livemode === b.livemode

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

/** One endpoint taking every type; keeps the events and deliveries the fan-out stores. */
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

let bus: MemoryBus
let requests: Requests
let webhooks: Webhooks
let scheduler: ReturnType<typeof memoryScheduler>
let clock: ManualClock
let settle: ActionSettlement
let seq: number

beforeEach(() => {
  bus = createMemoryBus({ contract: eventContract })
  requests = new Requests()
  webhooks = new Webhooks()
  scheduler = memoryScheduler()
  clock = manualClock(T0)
  seq = 0
  let n = 0
  const deps = { uow: memoryUnitOfWork(bus, { requests, webhooks, timers: scheduler.timers('delivery') }), clock, newActionRequestId: () => `acr_${++n}`, newEventId: () => `evt_${++n}` }
  subscribeDelivery(bus, deps, scheduler)
  settle = actionSettlement(deps)
})

/** Publishes a fact as its owner does, and lets delivery handle it. */
async function fact(type: Parameters<typeof eventContract.versionOf>[0], key: string, data: unknown, id = `${type}:${key}:${++seq}`) {
  await bus.publish({ id, type, key, data, appRef })
  await bus.drain()
}
const decided = (actionKeys: string[], decidedBy = 'mem_jane') =>
  fact('case.decided.v1', 'case_1', {
    caseId: 'case_1',
    subjectExternalId: 'u_jack_doe',
    decisionId: 'dec_1',
    outcome: 'violation',
    categoryId: 'scams_fraud.romance_scam',
    severity: 'P1',
    actionKeys,
    reportIds: ['rpt_1'],
    decidedBy,
    occurredAt: T0.toISOString(),
  } satisfies EventData<'case.decided.v1'>)
const TRIAGE = {
  caseId: 'case_1',
  reportIds: ['rpt_1'],
  categoryId: 'scams_fraud.romance_scam',
  customCategoryId: null,
  signals: [],
  injectionSuspected: false,
  classifiedBy: 'llm',
  severity: 'P1',
  priority: 2000,
  slaDueAt: new Date(T0.getTime() + 24 * H).toISOString(),
  suggestedActionKeys: [],
} satisfies EventData<'case.retriaged.v1'>
const published = (type: string) => bus.log().filter((l) => l.event.type === type).map((l) => l.event.data as Record<string, unknown>)
const notes = () => bus.log().filter((l) => l.event.type.startsWith('notification.')).map((l) => `${l.event.type === 'notification.raised.v1' ? 'raised' : 'cleared'} ${l.event.key}`)

describe('action requests', () => {
  it('makes one pending request per action of a decision, in order, and asks for each', async () => {
    await decided(['suspend_7d', 'warn'])
    expect([...requests.rows.values()]).toEqual([
      { id: 'acr_1', appRef, caseId: 'case_1', decisionId: 'dec_1', actionKey: 'suspend_7d', status: 'pending', failReason: null, retryId: null, replacedBy: null },
      { id: 'acr_2', appRef, caseId: 'case_1', decisionId: 'dec_1', actionKey: 'warn', status: 'pending', failReason: null, retryId: null, replacedBy: null },
    ])
    const facts = { caseId: 'case_1', decisionId: 'dec_1', subjectExternalId: 'u_jack_doe', categoryId: 'scams_fraud.romance_scam', severity: 'P1', reason: 'decision', requestedBy: { type: 'member', id: 'mem_jane' } }
    expect(published('action.requested.v1')).toEqual([
      { actionRequestId: 'acr_1', actionKey: 'suspend_7d', ...facts },
      { actionRequestId: 'acr_2', actionKey: 'warn', ...facts },
    ])
  })

  it('confirms the decision once its last request is confirmed', async () => {
    await decided(['suspend_7d', 'warn'])
    await settle.confirm(appRef, 'acr_1')
    await bus.drain()
    expect(published('decision.actions_confirmed.v1')).toEqual([])
    await settle.confirm(appRef, 'acr_2')
    await bus.drain()
    expect(published('action.confirmed.v1')).toHaveLength(2)
    expect(published('decision.actions_confirmed.v1')).toEqual([{ caseId: 'case_1', decisionId: 'dec_1' }])
  })

  it('asks for nothing for a decision without actions (moderation closes it itself)', async () => {
    await decided([])
    expect(requests.rows.size).toBe(0)
    expect(published('action.requested.v1')).toEqual([])
  })

  it('records a failure once, and a settled request does not change again', async () => {
    await decided(['suspend_7d'])
    await settle.fail(appRef, 'acr_1', 'user not found')
    await bus.drain()
    expect(requests.rows.get('acr_1')).toMatchObject({ status: 'failed', failReason: 'user not found' })
    await settle.confirm(appRef, 'acr_1')
    await settle.fail(appRef, 'acr_1', 'again')
    await bus.drain()
    expect(requests.rows.get('acr_1')).toMatchObject({ status: 'failed', failReason: 'user not found' })
    expect(published('action.failed.v1')).toEqual([{ actionRequestId: 'acr_1', caseId: 'case_1' }])
  })

  it('refuses an unknown action request', async () => {
    await expect(settle.confirm(appRef, 'acr_nope')).rejects.toThrow()
    await expect(settle.fail(appRef, 'acr_nope', 'x')).rejects.toThrow()
  })

  it('is safe to replay: no second request for a decision', async () => {
    await decided(['warn'])
    const before = bus.log().length
    bus.replay('delivery')
    await bus.drain()
    expect(requests.rows.size).toBe(1)
    expect(bus.log()).toHaveLength(before)
    expect(bus.deadLetters()).toEqual([])
  })

  it('raises action_overdue for a request unanswered for 24 hours, and clears it at the answer', async () => {
    await decided(['suspend_7d', 'warn'])
    await settle.confirm(appRef, 'acr_1')
    clock.advance(24 * H)
    await scheduler.fireDue(clock.now())
    await bus.drain()
    expect(notes()).toEqual(['raised action_overdue:acr_2'])
    await settle.fail(appRef, 'acr_2', 'account not found')
    await bus.drain()
    expect(notes()).toEqual(['raised action_overdue:acr_2', 'cleared action_overdue:acr_2'])
  })
})

describe('webhooks', () => {
  it('queues report.triaged once per case, with its reports and classification and no summary', async () => {
    await fact('case.triaged.v1', 'case_1', { ...TRIAGE, cause: 'classification' }, 'case.triaged:case_1')
    await fact('case.triaged.v1', 'case_1', { ...TRIAGE, cause: 'classification' }, 'case.triaged:case_1')
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
  })

  it("sends a correction's or the LLM's later triage only once moderation took it, as case.retriaged", async () => {
    await fact('case.triaged.v1', 'case_1', { ...TRIAGE, cause: 'correction' })
    await fact('case.triaged.v1', 'case_1', { ...TRIAGE, categoryId: 'scams_fraud.investment_scam', cause: 'llm_retry' })
    expect(webhooks.events.size).toBe(0)
    await fact('case.retriaged.v1', 'case_1', { ...TRIAGE, categoryId: 'scams_fraud.investment_scam' })
    expect(webhooks.bodies()).toMatchObject([{ type: 'report.triaged', data: { category_id: 'scams_fraud.investment_scam' } }])
  })

  it('queues one action.requested per action, naming who decided', async () => {
    await decided(['suspend_7d'], 'key_jane')
    expect(webhooks.bodies().filter((b) => b.type === 'action.requested').map((b) => b.data)).toEqual([
      {
        action_request_id: 'acr_1',
        action_key: 'suspend_7d',
        subject_external_id: 'u_jack_doe',
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
    await fact('case.triaged.v1', 'case_1', { ...TRIAGE, cause: 'classification' })
    await decided(['warn'])
    expect(webhooks.events.size).toBe(0)
    expect(bus.deadLetters()).toEqual([])
  })
})
