// Moderation as a service: its use cases, each run in one transaction of its own with its events,
// and its reactions to other services' facts on the bus. It reads only its own tables and its copy
// of the app's policy.

import { allowedActionKeys, currentType, erasedId, erasureAnswer, policyIn, type EventData, type Policy } from '@flagwise/contracts'
import type { Clock } from '@flagwise/kernel'
import { subscribeCopy, tenantOf, type DocumentCopy, type EventBus, type UnitOfWork, type Work } from '@flagwise/platform'
import { nextState } from '../domain/case-state.ts'
import type { ActionCatalog, CaseClassification, CaseRecord, CaseRepository, CaseTriage, CaseWorkDeps, ModerationEvent, Decision, Severity } from './ports.ts'
import { receiveReport, type ReportReceived } from './receive-report.ts'
import { claimCase, correctCase, decideCase, releaseCase, retryActions, type CaseRef, type CorrectInput, type DecideInput, type RetryActionsInput } from './work-case.ts'

export interface ModerationStores {
  readonly cases: CaseRepository
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
  allowedActionKeys: async (tenant, categoryId) => allowedActionKeys(await policyIn(deps.policy, tenant), categoryId),
})

const workOf = (deps: ModerationServiceDeps, w: Work<ModerationStores>): CaseWorkDeps => ({
  cases: w.stores.cases,
  clock: deps.clock,
  catalog: catalogOf(deps),
  newCaseId: deps.newCaseId,
  newDecisionId: deps.newDecisionId,
  events: {
    async publish(event: ModerationEvent) {
      const { type, tenant: _tenant, ...data } = event
      await w.publish({ id: casesEventId(event, deps.newEventId), type: currentType(type), key: event.caseId, data })
    },
  },
})

/** claimCase, releaseCase, decideCase, correctCase and retryActions, each in one transaction with its events. */
export function moderationService(deps: ModerationServiceDeps): ModerationService {
  const { uow } = deps
  return {
    claim: (input) => uow.run(input.tenant, (w) => claimCase(workOf(deps, w), input)),
    release: (input) => uow.run(input.tenant, (w) => releaseCase(workOf(deps, w), input)),
    decide: (input) => uow.run(input.tenant, (w) => decideCase(workOf(deps, w), input)),
    correct: (input) => uow.run(input.tenant, (w) => correctCase(workOf(deps, w), input)),
    retryActions: (input) => uow.run(input.tenant, (w) => retryActions(workOf(deps, w), input)),
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
 * - 'cases.erasure': subject.erasure_requested -> under the subject's lock, eraseAccount; answers
 *   erased, or nothing_held.
 * - 'cases.actions': action.failed -> notes the failure; a new one moves a decided case to
 *   action_failed. decision.actions_confirmed -> a decided or action_failed case with that
 *   decision is actioned.
 */
export function subscribeModeration(bus: EventBus, deps: ModerationServiceDeps): void {
  const { uow } = deps
  subscribeCopy(bus, 'cases.policy', 'policy.updated.v1', deps.policy, (d) => {
    const u = d as EventData<'policy.updated.v1'>
    return { version: u.version, document: u.policy }
  })

  bus.subscribe('cases.intake', ['report.received.v1'], async (event) => {
    const { facts, p0Signals: _signals, injectionSuspected: _injection, ...report } = event.data as EventData<'report.received.v1'>
    const tenant = tenantOf(event)
    const time = (v: string | null) => (v === null ? null : new Date(v))
    const received: ReportReceived = {
      ...report,
      tenant,
      ...(facts && { facts: { reporterExternalId: facts.reporterExternalId, reporterAccountCreatedAt: time(facts.reporterAccountCreatedAt), reportedAccountCreatedAt: time(facts.reportedAccountCreatedAt) } }),
    }
    await uow.run(tenant, (w) => receiveReport(workOf(deps, w), received))
  })

  bus.subscribe('cases.triage', ['case.classified.v1', 'case.untriaged.v1', 'case.triaged.v1'], async (event) => {
    const tenant = tenantOf(event)
    await uow.run(tenant, async (w) => {
      const cases = w.stores.cases
      if (event.type === 'case.classified.v1') {
        const c = event.data as EventData<'case.classified.v1'>
        await cases.change(tenant, c.caseId, { states: ['classifying'] }, { classification: classificationOf(c) })
        return
      }
      if (event.type === 'case.untriaged.v1') {
        const { caseId } = event.data as EventData<'case.untriaged.v1'>
        await cases.change(tenant, caseId, { states: ['classifying'] }, { state: nextState('classifying', { type: 'marked_untriaged' }) })
        return
      }
      const d = event.data as EventData<'case.triaged.v1'>
      const record = await cases.findById(tenant, d.caseId)
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
          await cases.change(tenant, d.caseId, { states: [record.state], claimedBy: record.claim?.memberId ?? null }, { triage })
        }
        return
      }
      const classification = classificationOf(d)
      let taken = false
      if (record.state === 'classifying') {
        await cases.change(tenant, d.caseId, { states: ['classifying'] }, { state: nextState('classifying', { type: 'triaged' }), triage, classification })
      } else if (record.state === 'untriaged') {
        const state = nextState(nextState('untriaged', { type: 'classify_retried' }), { type: 'triaged' })
        taken = await cases.change(tenant, d.caseId, { states: ['untriaged'] }, { state, triage, classification })
      } else if (record.state === 'open' && record.triage) {
        taken = await cases.change(tenant, d.caseId, { states: ['open'], claimedBy: null }, { triage, classification })
      }
      if (taken && d.cause === 'llm_retry') {
        const { cause: _cause, ...retriaged } = d
        await w.publish({ id: `case.retriaged:${event.id}`, type: currentType('case.retriaged'), key: d.caseId, data: retriaged })
      }
    })
  })

  bus.subscribe('cases.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const tenant = tenantOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await uow.run(tenant, async (w) => {
      await w.stores.cases.lockSubject(tenant, request.subjectExternalId)
      const had = await w.stores.cases.eraseAccount(tenant, request.subjectExternalId, erasedId(request.erasureId))
      await w.publish(erasureAnswer(request, 'cases.erasure', had > 0 ? 'erased' : 'nothing_held', deps.clock.now()))
    })
  })

  bus.subscribe('cases.actions', ['action.failed.v1', 'decision.actions_confirmed.v1'], async (event) => {
    const tenant = tenantOf(event)
    await uow.run(tenant, async (w) => {
      const cases = w.stores.cases
      if (event.type === 'action.failed.v1') {
        const { caseId, actionRequestId } = event.data as EventData<'action.failed.v1'>
        if (!(await cases.addActionFailure(tenant, caseId, actionRequestId, deps.clock.now()))) return
        await cases.change(tenant, caseId, { states: ['decided'] }, { state: nextState('decided', { type: 'action_failed' }) })
        return
      }
      const { caseId, decisionId } = event.data as EventData<'decision.actions_confirmed.v1'>
      await cases.change(tenant, caseId, { states: ['decided', 'action_failed'], decisionId }, { state: 'actioned' })
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
