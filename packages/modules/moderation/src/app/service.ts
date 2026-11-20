// Moderation as a service: its use cases, each run in one transaction of its own with its events,
// and its reactions to other services' facts on the bus. It reads only its own tables and its copy
// of the app's policy.

import { allowedActionKeys, currentType, erasedId, erasureAnswer, notificationCleared, notificationRaised, policyIn, type EventData, type Policy } from '@flagwise/contracts'
import type { AppRef, Clock } from '@flagwise/kernel'
import { subscribeCopy, appOf, type DocumentCopy, type EventBus, type Scheduler, type Timers, type UnitOfWork, type Work } from '@flagwise/platform'
import { nextState } from '../domain/case-state.ts'
import { slaWarningAt } from '../domain/sla.ts'
import type { ActionCatalog, CaseClassification, CaseRecord, CaseRepository, CaseTriage, CaseWorkDeps, ModerationEvent, Decision, Severity } from './ports.ts'
import { receiveReport, type ReportReceived } from './receive-report.ts'
import { claimCase, correctCase, decideCase, releaseCase, retryActions, type CaseRef, type CorrectInput, type DecideInput, type RetryActionsInput } from './work-case.ts'

export interface ModerationStores {
  readonly cases: CaseRepository
  /** Moderation's timers: each case's SLA warning and breach. */
  readonly timers: Timers
}

export interface ModerationServiceDeps {
  readonly uow: UnitOfWork<ModerationStores>
  /** Moderation's copy of each app's policy, kept from policy.updated. */
  readonly policy: DocumentCopy<Policy>
  readonly clock: Clock
  readonly newCaseId: () => string
  readonly newDecisionId: () => string
  /** Unique ids for events that can happen more than once per case (claims, releases). */
  readonly newEventId: () => string
}

export interface ModerationService {
  claim(input: CaseRef): Promise<CaseRecord>
  release(input: CaseRef & { readonly force?: boolean }): Promise<CaseRecord>
  decide(input: DecideInput): Promise<Decision>
  correct(input: CorrectInput): Promise<CaseRecord>
  retryActions(input: RetryActionsInput): Promise<CaseRecord>
}

/** Which action keys a category allows, from moderation's copy of the policy. */
const catalogOf = (deps: ModerationServiceDeps): ActionCatalog => ({
  allowedActionKeys: async (appRef, categoryId) => allowedActionKeys(await policyIn(deps.policy, appRef), categoryId),
})

const workOf = (deps: ModerationServiceDeps, w: Work<ModerationStores>): CaseWorkDeps => ({
  cases: w.stores.cases,
  clock: deps.clock,
  catalog: catalogOf(deps),
  newCaseId: deps.newCaseId,
  newDecisionId: deps.newDecisionId,
  events: {
    async publish(event: ModerationEvent) {
      const { type, appRef: _appRef, ...data } = event
      await w.publish({ id: casesEventId(event, deps.newEventId), type: currentType(type), key: event.caseId, data })
      // The pre-rules found a P0 signal: people hear of the case at once, before it is classified.
      if (event.type === 'case.opened' && event.band === 'p0') await w.publish(notificationRaised('new_p0', event.caseId, { caseId: event.caseId }, event.occurredAt))
    },
  },
})

const isP0 = (c: CaseRecord) => c.band === 'p0' || c.triage?.severity === 'P0'
const slaKeys = (caseId: string) => [`sla_75:${caseId}`, `sla_breach:${caseId}`] as const

/**
 * Sets the case's SLA timers from its triage: the warning at 75% (slaWarningAt) and the breach at
 * the due time. Setting them again moves them.
 */
async function setSlaTimers(timers: Timers, appRef: AppRef, record: CaseRecord, triage: CaseTriage): Promise<void> {
  const [warning, breach] = slaKeys(record.id)
  await timers.set(appRef, warning, slaWarningAt(record.openedAt, triage.slaDueAt), { caseId: record.id })
  await timers.set(appRef, breach, triage.slaDueAt, { caseId: record.id })
}

/**
 * claimCase, releaseCase, decideCase, correctCase and retryActions, each in one transaction with
 * its events. Claiming a P0 case clears its new_p0 notification. Deciding a case cancels its SLA
 * timers and clears the SLA notifications of those that fired already (cancel says which).
 */
export function moderationService(deps: ModerationServiceDeps): ModerationService {
  const { uow } = deps
  return {
    claim: (input) =>
      uow.run(input.appRef, async (w) => {
        const claimed = await claimCase(workOf(deps, w), input)
        if (isP0(claimed)) await w.publish(notificationCleared('new_p0', claimed.id, 'case.claimed', deps.clock.now()))
        return claimed
      }),
    release: (input) => uow.run(input.appRef, (w) => releaseCase(workOf(deps, w), input)),
    decide: (input) =>
      uow.run(input.appRef, async (w) => {
        const decision = await decideCase(workOf(deps, w), input)
        const record = await w.stores.cases.findById(input.appRef, input.caseId)
        if (record?.triage) {
          const [warning, breach] = slaKeys(record.id)
          if (!(await w.stores.timers.cancel(input.appRef, warning))) await w.publish(notificationCleared('sla_75', record.id, 'case.decided', decision.decidedAt))
          if (!(await w.stores.timers.cancel(input.appRef, breach))) await w.publish(notificationCleared('sla_breach', record.id, 'case.decided', decision.decidedAt))
        }
        return decision
      }),
    correct: (input) => uow.run(input.appRef, (w) => correctCase(workOf(deps, w), input)),
    retryActions: (input) => uow.run(input.appRef, (w) => retryActions(workOf(deps, w), input)),
  }
}

/**
 * Subscribes moderation's groups (event -> effect), each change conditional, so a case no longer
 * in the expected state is left alone:
 * - 'cases.policy': policy.updated -> its copy of the app's policy (first).
 * - 'cases.intake': report.received -> receiveReport, with the report's account facts when it
 *   carries them.
 * - 'cases.triage': case.classified -> the classification's facts on a classifying case;
 *   case.untriaged -> a classifying case waits as untriaged; case.triaged -> the triage and the
 *   classification's facts on the case: a classifying or untriaged case opens, an open unclaimed
 *   one that has a triage takes the new one (triage published it again after the LLM answered),
 *   and then publishes case.retriaged, so the tenant hears of it only if the case took it.
 *   One caused by a correction: an undecided case (claimed or open) still in the corrected
 *   category takes its triage; an older correction's, for a category corrected again since, is
 *   left for the newer one's.
 *   A case that takes a triage (re)sets its SLA timers; one that opens or takes a new triage
 *   unclaimed raises new_p0 when triage made it P0 (a P0 band case raised it when it opened).
 * - Timers of 'moderation': a case's SLA warning or breach came -> sla_75 or sla_breach, when the
 *   case has a triage and no decision.
 * - 'cases.erasure': subject.erasure_requested -> under the subject's lock, eraseAccount; answers
 *   erased, or nothing_held.
 * - 'cases.actions': action.failed -> notes the failure; a new one moves a decided case to
 *   action_failed. decision.actions_confirmed -> a decided or action_failed case with that
 *   decision is actioned.
 */
export function subscribeModeration(bus: EventBus, deps: ModerationServiceDeps, scheduler: Scheduler): void {
  const { uow } = deps
  scheduler.on('moderation', async (timer) => {
    const caseId = timer.data['caseId']
    if (!caseId) return
    await uow.run(timer.appRef, async (w) => {
      const record = await w.stores.cases.findById(timer.appRef, caseId)
      if (!record?.triage || record.decision) return
      const type = timer.key.startsWith('sla_75:') ? 'sla_75' : 'sla_breach'
      await w.publish(notificationRaised(type, caseId, { caseId, slaDueAt: record.triage.slaDueAt.toISOString() }, deps.clock.now()))
    })
  })
  subscribeCopy(bus, 'cases.policy', 'policy.updated.v1', deps.policy, (d) => {
    const u = d as EventData<'policy.updated.v1'>
    return { version: u.version, document: u.policy }
  })

  bus.subscribe('cases.intake', ['report.received.v1'], async (event) => {
    const { facts, p0Signals: _signals, injectionSuspected: _injection, ...report } = event.data as EventData<'report.received.v1'>
    const appRef = appOf(event)
    const time = (v: string | null) => (v === null ? null : new Date(v))
    const received: ReportReceived = {
      ...report,
      appRef,
      ...(facts && { facts: { reporterExternalId: facts.reporterExternalId, reporterAccountCreatedAt: time(facts.reporterAccountCreatedAt), reportedAccountCreatedAt: time(facts.reportedAccountCreatedAt) } }),
    }
    await uow.run(appRef, (w) => receiveReport(workOf(deps, w), received))
  })

  bus.subscribe('cases.triage', ['case.classified.v1', 'case.untriaged.v1', 'case.triaged.v1'], async (event) => {
    const appRef = appOf(event)
    await uow.run(appRef, async (w) => {
      const cases = w.stores.cases
      if (event.type === 'case.classified.v1') {
        const c = event.data as EventData<'case.classified.v1'>
        await cases.change(appRef, c.caseId, { states: ['classifying'] }, { classification: classificationOf(c) })
        return
      }
      if (event.type === 'case.untriaged.v1') {
        const { caseId } = event.data as EventData<'case.untriaged.v1'>
        await cases.change(appRef, caseId, { states: ['classifying'] }, { state: nextState('classifying', { type: 'marked_untriaged' }) })
        return
      }
      const d = event.data as EventData<'case.triaged.v1'>
      const record = await cases.findById(appRef, d.caseId)
      if (!record) return
      const triage: CaseTriage = {
        severity: d.severity,
        priority: d.priority,
        slaDueAt: new Date(d.slaDueAt),
        suggestedActionKeys: d.suggestedActionKeys,
        ...(d.applied && { applied: d.applied }),
        ...(d.flags && { flags: d.flags }),
      }
      if (d.cause === 'correction') {
        if ((record.state === 'claimed' || record.state === 'open') && record.classification?.categoryId === d.categoryId) {
          if (await cases.change(appRef, d.caseId, { states: [record.state], claimedBy: record.claim?.memberId ?? null }, { triage })) await setSlaTimers(w.stores.timers, appRef, record, triage)
        }
        return
      }
      const classification = classificationOf(d)
      let taken = false
      let opened = false
      if (record.state === 'classifying') {
        opened = await cases.change(appRef, d.caseId, { states: ['classifying'] }, { state: nextState('classifying', { type: 'triaged' }), triage, classification })
      } else if (record.state === 'untriaged') {
        const state = nextState(nextState('untriaged', { type: 'classify_retried' }), { type: 'triaged' })
        taken = await cases.change(appRef, d.caseId, { states: ['untriaged'] }, { state, triage, classification })
      } else if (record.state === 'open' && record.triage) {
        taken = await cases.change(appRef, d.caseId, { states: ['open'], claimedBy: null }, { triage, classification })
      }
      if (opened || taken) {
        await setSlaTimers(w.stores.timers, appRef, record, triage)
        // Triage found a P0 the pre-rules did not (a P0 band case was raised when it opened).
        if (triage.severity === 'P0' && record.band !== 'p0') await w.publish(notificationRaised('new_p0', d.caseId, { caseId: d.caseId }, deps.clock.now()))
      }
      if (taken && d.cause === 'llm_retry') {
        const { cause: _cause, ...retriaged } = d
        await w.publish({ id: `case.retriaged:${event.id}`, type: currentType('case.retriaged'), key: d.caseId, data: retriaged })
      }
    })
  })

  bus.subscribe('cases.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const appRef = appOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await uow.run(appRef, async (w) => {
      await w.stores.cases.lockSubject(appRef, request.subjectExternalId)
      const had = await w.stores.cases.eraseAccount(appRef, request.subjectExternalId, erasedId(request.erasureId))
      await w.publish(erasureAnswer(request, 'cases.erasure', had > 0 ? 'erased' : 'nothing_held', deps.clock.now()))
    })
  })

  bus.subscribe('cases.actions', ['action.failed.v1', 'decision.actions_confirmed.v1'], async (event) => {
    const appRef = appOf(event)
    await uow.run(appRef, async (w) => {
      const cases = w.stores.cases
      if (event.type === 'action.failed.v1') {
        const { caseId, actionRequestId } = event.data as EventData<'action.failed.v1'>
        if (!(await cases.addActionFailure(appRef, caseId, actionRequestId, deps.clock.now()))) return
        await cases.change(appRef, caseId, { states: ['decided'] }, { state: nextState('decided', { type: 'action_failed' }) })
        return
      }
      const { caseId, decisionId } = event.data as EventData<'decision.actions_confirmed.v1'>
      await cases.change(appRef, caseId, { states: ['decided', 'action_failed'], decisionId }, { state: 'actioned' })
    })
  })
}

/** The facts of a classification the case keeps, from case.classified or case.triaged. */
function classificationOf(c: { readonly categoryId: string; readonly customCategoryId?: string | null | undefined; readonly signals: readonly string[]; readonly injectionSuspected: boolean; readonly classifiedBy: 'llm' | 'rules' }): CaseClassification {
  const customCategoryId = c.customCategoryId ?? null
  return {
    categoryId: c.categoryId,
    signals: c.signals,
    injectionSuspected: c.injectionSuspected,
    classifiedBy: c.classifiedBy,
    ...(customCategoryId !== null && { customCategoryId }),
  }
}

/**
 * Natural ids for events that happen once per thing; generated ids for ones that can repeat:
 *
 *   case.opened                        `case.opened:${caseId}`
 *   case.report_attached               `case.report_attached:${reportId}`
 *   case.decided                       `case.decided:${decisionId}`
 *   case.claimed, case.released,
 *   case.corrected, case.actions_retried `${type}:${caseId}:${newEventId()}`
 */
function casesEventId(event: ModerationEvent, newEventId: () => string): string {
  switch (event.type) {
    case 'case.opened':
      return `case.opened:${event.caseId}`
    case 'case.report_attached':
      return `case.report_attached:${event.reportId}`
    case 'case.decided':
      return `case.decided:${event.decisionId}`
    case 'case.claimed':
    case 'case.released':
    case 'case.corrected':
    case 'case.actions_retried':
      return `${event.type}:${event.caseId}:${newEventId()}`
  }
}
