// Moderation on an in-memory bus, alone: the facts the other services publish (a report received,
// a case classified, triaged or untriaged, an action failed or every action confirmed) in, its
// cases and the facts it publishes out, including its notifications and its SLA timers.
import { DEFAULT_POLICY, eventContract, type EventData, type Policy, type PolicyActionKey } from '@flagwise/contracts'
import { manualClock, type AppRef, type ManualClock } from '@flagwise/kernel'
import { createMemoryBus, memoryDocumentCopy, memoryScheduler, memoryUnitOfWork, type MemoryBus } from '@flagwise/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { moderationService, subscribeModeration, type ModerationService } from '../src/index.ts'
import { InMemoryCaseRepository } from './fakes.ts'

const appRef: AppRef = { appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-21T09:00:00.000Z')
const H = 3_600_000
const actionKey = (key: string): PolicyActionKey => ({ key, label: { en: key, id: null }, description: null, reverseKey: null, autoAllowed: false, categories: ['*'] })
const POLICY: Policy = { ...DEFAULT_POLICY, actionKeys: ['warn', 'suspend_7d', 'ban'].map(actionKey) }

let bus: MemoryBus
let cases: InMemoryCaseRepository
let scheduler: ReturnType<typeof memoryScheduler>
let clock: ManualClock
let work: ModerationService
let seq: number

beforeEach(async () => {
  bus = createMemoryBus({ contract: eventContract })
  cases = new InMemoryCaseRepository()
  scheduler = memoryScheduler()
  clock = manualClock(T0)
  seq = 0
  const policy = memoryDocumentCopy<Policy>()
  await policy.keep(appRef, 1, POLICY)
  let n = 0
  const deps = {
    uow: memoryUnitOfWork(bus, { cases, timers: scheduler.timers('moderation') }),
    policy,
    clock,
    newCaseId: () => `case_${++n}`,
    newDecisionId: () => `dec_${++n}`,
    newEventId: () => `evt_${++n}`,
  }
  subscribeModeration(bus, deps, scheduler)
  work = moderationService(deps)
})

/** Publishes a fact as its owner does, and lets moderation handle it. */
async function fact<T extends Parameters<typeof eventContract.versionOf>[0]>(type: T, key: string, data: unknown, at = appRef) {
  await bus.publish({ id: `${type}:${key}:${++seq}`, type, key, data, appRef: at })
  await bus.drain()
}
const received = (reportId: string, subject = 'u_jack_doe', p0Signal = false, at = appRef) =>
  fact('report.received.v1', reportId, { reportId, subjectExternalId: subject, p0Signal } satisfies EventData<'report.received.v1'>, at)
const classification = (caseId: string, categoryId = 'scams_fraud.romance_scam') => ({ caseId, categoryId, customCategoryId: null, signals: [], injectionSuspected: false, classifiedBy: 'llm' as const })
const triaged = (caseId: string, over: Partial<EventData<'case.triaged.v1'>> = {}) =>
  fact('case.triaged.v1', caseId, {
    ...classification(caseId),
    reportIds: [...cases.get(caseId)!.reportIds],
    severity: 'P1',
    priority: 2000,
    slaDueAt: new Date(T0.getTime() + 24 * H).toISOString(),
    suggestedActionKeys: [],
    cause: 'classification',
    ...over,
  } satisfies EventData<'case.triaged.v1'>)
/** A report through to an open, triaged case. */
const openCase = async (reportId = 'rpt_1', over: Partial<EventData<'case.triaged.v1'>> = {}, p0Signal = false) => {
  await received(reportId, 'u_jack_doe', p0Signal)
  const caseId = cases.all().find((c) => c.reportIds.includes(reportId))!.id
  await fact('case.classified.v1', caseId, { ...classification(caseId), reportId, preRuleP0: false } satisfies EventData<'case.classified.v1'>)
  await triaged(caseId, over)
  return caseId
}
const decide = (caseId: string, actionKeys: string[]) => work.decide({ appRef, caseId, memberId: 'mem_jane', outcome: 'violation', categoryId: 'scams_fraud.romance_scam', severity: 'P1', actionKeys })
const published = (type: string) => bus.log().filter((l) => l.event.type === type).map((l) => l.event)
/** The notification facts moderation published, as `raised key` or `cleared key`. */
const notes = () => bus.log().filter((l) => l.event.type.startsWith('notification.')).map((l) => `${l.event.type === 'notification.raised.v1' ? 'raised' : 'cleared'} ${l.event.key}`)
const fire = async (ms: number) => {
  clock.advance(ms)
  await scheduler.fireDue(clock.now())
  await bus.drain()
}

describe('cases from reports', () => {
  it('opens a case for a report, attaches the next one of the account, and ignores a duplicate', async () => {
    await received('rpt_1')
    await received('rpt_2')
    await received('rpt_1')
    expect(cases.all()).toMatchObject([{ id: 'case_1', state: 'classifying', band: 'standard', reportIds: ['rpt_1', 'rpt_2'] }])
    expect(published('case.opened.v1')).toHaveLength(1)
    expect(published('case.report_attached.v1').map((e) => e.data)).toMatchObject([{ caseId: 'case_1', reportId: 'rpt_2' }])
  })

  it('opens a P0 report its own case, and keeps apps apart', async () => {
    await received('rpt_1')
    await received('rpt_2', 'u_jack_doe', true)
    await received('rpt_3', 'u_jack_doe', false, { ...appRef, appId: 'app_b' })
    expect(cases.all().map((c) => [c.reportIds, c.band, c.appRef.appId])).toEqual([
      [['rpt_1'], 'standard', 'app_a'],
      [['rpt_2'], 'p0', 'app_a'],
      [['rpt_3'], 'standard', 'app_b'],
    ])
  })
})

describe("triage's results", () => {
  it('opens a classified case with its triage', async () => {
    const caseId = await openCase()
    expect(cases.get(caseId)).toMatchObject({ state: 'open', classification: { categoryId: 'scams_fraud.romance_scam' }, triage: { severity: 'P1', priority: 2000, slaDueAt: new Date(T0.getTime() + 24 * H) } })
  })

  it('moves an untriaged case to open once triage answers', async () => {
    await received('rpt_1')
    await fact('case.untriaged.v1', 'case_1', { caseId: 'case_1', reason: 'provider_error' } satisfies EventData<'case.untriaged.v1'>)
    expect(cases.get('case_1')).toMatchObject({ state: 'untriaged' })
    expect(cases.get('case_1')?.triage).toBeFalsy()
    await triaged('case_1', { cause: 'llm_retry' })
    expect(cases.get('case_1')).toMatchObject({ state: 'open', triage: { severity: 'P1' } })
  })

  it("takes the LLM's later triage while nobody holds the case, telling the tenant again only then", async () => {
    const caseId = await openCase()
    await triaged(caseId, { categoryId: 'scams_fraud.investment_scam', cause: 'llm_retry' })
    expect(cases.get(caseId)).toMatchObject({ classification: { categoryId: 'scams_fraud.investment_scam' } })
    expect(published('case.retriaged.v1')).toHaveLength(1)

    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    await triaged(caseId, { categoryId: 'spam.spam', cause: 'llm_retry' })
    expect(cases.get(caseId)).toMatchObject({ state: 'claimed', classification: { categoryId: 'scams_fraud.investment_scam' } })
    expect(published('case.retriaged.v1')).toHaveLength(1)
  })

  it("takes a correction's triage, and leaves an older correction's for the newer one's", async () => {
    const caseId = await openCase()
    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    await work.correct({ appRef, caseId, memberId: 'mem_jane', categoryId: 'spam.spam' })
    await work.correct({ appRef, caseId, memberId: 'mem_jane', categoryId: 'child_safety.grooming' })
    expect(published('case.corrected.v2')).toHaveLength(2)
    // Triage's answers to both arrive; the one for the older category changes nothing.
    await triaged(caseId, { categoryId: 'spam.spam', severity: 'P2', priority: 1000, cause: 'correction' })
    await triaged(caseId, { categoryId: 'child_safety.grooming', severity: 'P0', priority: 9000, slaDueAt: new Date(T0.getTime() + H).toISOString(), cause: 'correction' })
    expect(cases.get(caseId)).toMatchObject({ state: 'claimed', classification: { categoryId: 'child_safety.grooming' }, triage: { severity: 'P0', slaDueAt: new Date(T0.getTime() + H) } })
  })
})

describe('the answers to a decision', () => {
  it('closes a decision once every action is confirmed, or at once without actions', async () => {
    const caseId = await openCase()
    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    const decision = await decide(caseId, ['suspend_7d'])
    await bus.drain()
    expect(cases.get(caseId)?.state).toBe('decided')
    await fact('decision.actions_confirmed.v1', caseId, { caseId, decisionId: decision.id } satisfies EventData<'decision.actions_confirmed.v1'>)
    expect(cases.get(caseId)?.state).toBe('actioned')

    const other = await openCase('rpt_2', {})
    await work.claim({ appRef, caseId: other, memberId: 'mem_jane' })
    await decide(other, [])
    expect(cases.get(other)?.state).toBe('actioned')
  })

  it('notes a failure once, and a retry answering it moves the case back to decided', async () => {
    const caseId = await openCase()
    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    const decision = await decide(caseId, ['suspend_7d', 'warn'])
    const failed = (actionRequestId: string) => fact('action.failed.v1', actionRequestId, { actionRequestId, caseId } satisfies EventData<'action.failed.v1'>)
    await failed('acr_1')
    await failed('acr_1')
    expect(cases.get(caseId)?.state).toBe('action_failed')

    // The retry answers the failure moderation knows of; one arriving after it waits for another answer.
    await work.retryActions({ appRef, caseId, memberId: 'mem_jane', actionKeys: ['ban'] })
    expect(published('case.actions_retried.v1').map((e) => e.data)).toMatchObject([{ caseId, actionKeys: ['ban'], replaces: ['acr_1'] }])
    await failed('acr_2')
    expect(cases.get(caseId)?.state).toBe('action_failed')
    await work.retryActions({ appRef, caseId, memberId: 'mem_jane', actionKeys: [] })
    expect(cases.get(caseId)?.state).toBe('decided')
    // Replaying the failures changes nothing; the confirmation closes it.
    bus.replay('cases.actions')
    await bus.drain()
    expect(cases.get(caseId)?.state).toBe('decided')
    await fact('decision.actions_confirmed.v1', caseId, { caseId, decisionId: decision.id } satisfies EventData<'decision.actions_confirmed.v1'>)
    expect(cases.get(caseId)?.state).toBe('actioned')
    expect(bus.deadLetters()).toEqual([])
  })

  it('is safe to replay every group', async () => {
    const caseId = await openCase()
    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    await decide(caseId, ['warn'])
    await bus.drain()
    const before = { cases: cases.all(), log: bus.log().length }
    for (const group of ['cases.intake', 'cases.triage', 'cases.actions']) bus.replay(group)
    await bus.drain()
    expect(cases.all()).toEqual(before.cases)
    expect(bus.log()).toHaveLength(before.log)
    expect(bus.deadLetters()).toEqual([])
  })
})

describe('notifications and SLA timers', () => {
  it('raises new_p0 when a P0 case opens, and clears it when someone claims it', async () => {
    await received('rpt_1', 'u_jack_doe', true)
    expect(notes()).toEqual(['raised new_p0:case_1'])
    await fact('case.classified.v1', 'case_1', { ...classification('case_1', 'child_safety.underage_user'), reportId: 'rpt_1', preRuleP0: true } satisfies EventData<'case.classified.v1'>)
    await triaged('case_1', { categoryId: 'child_safety.underage_user', severity: 'P0' })
    // Triage agreeing on P0 raises nothing more for a case that opened as P0.
    expect(notes()).toEqual(['raised new_p0:case_1'])
    await work.claim({ appRef, caseId: 'case_1', memberId: 'mem_jane' })
    await bus.drain()
    expect(notes()).toEqual(['raised new_p0:case_1', 'cleared new_p0:case_1'])
  })

  it('raises new_p0 when triage makes a case P0 the pre-rules did not', async () => {
    const caseId = await openCase('rpt_1', { categoryId: 'child_safety.underage_user', severity: 'P0' })
    expect(cases.get(caseId)).toMatchObject({ band: 'standard', triage: { severity: 'P0' } })
    expect(notes()).toEqual([`raised new_p0:${caseId}`])
  })

  it('raises the SLA warning and breach of an undecided case, and clears them at its decision', async () => {
    const caseId = await openCase()
    const span = 24 * H
    await fire(Math.floor((span * 3) / 4) - 1)
    expect(notes()).toEqual([])
    await fire(1)
    expect(notes()).toEqual([`raised sla_75:${caseId}`])
    await fire(span)
    expect(notes()).toEqual([`raised sla_75:${caseId}`, `raised sla_breach:${caseId}`])
    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    await decide(caseId, [])
    await bus.drain()
    expect(notes()).toEqual([`raised sla_75:${caseId}`, `raised sla_breach:${caseId}`, `cleared sla_75:${caseId}`, `cleared sla_breach:${caseId}`])
  })

  it('raises nothing for a case decided in time, and its timers are gone', async () => {
    const caseId = await openCase()
    await work.claim({ appRef, caseId, memberId: 'mem_jane' })
    await decide(caseId, ['warn'])
    await fire(30 * 24 * H)
    expect(notes()).toEqual([])
    expect(scheduler.list()).toEqual([])
  })
})
