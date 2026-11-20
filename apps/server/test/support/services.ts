// The services of the core loop put together on one bus for tests, as server.ts puts them: flagging's
// report.received, classify (or a fixed classifier in its place), triage, moderation and delivery,
// each on its own unit of work. It hands back moderation's and delivery's use cases, and
// submitReport, which publishes report.received as flagging does.

import { moderationService, subscribeModeration, type CaseRecord, type CaseRef, type ModerationServiceDeps, type CorrectInput, type DecideInput, type Decision, type ReportFacts, type RetryActionsInput } from '@flagwise/moderation'
import { subscribeClassify, type ClassifyServiceDeps } from '@flagwise/classify'
import { currentType, DEFAULT_POLICY, type EventData, type Policy, type PolicyActionKey } from '@flagwise/contracts'
import { actionSettlement, subscribeDelivery, type DeliveryServiceDeps } from '@flagwise/delivery'
import type { Clock, AppRef } from '@flagwise/kernel'
import { appOf, type EventBus, type Scheduler } from '@flagwise/platform'
import { erasedFromCase, subscribeTriage, type TriageCase, type TriageCaseStore, type TriageDeps } from '@flagwise/triage'

/** What a fixed classifier says about a case. */
export interface Classification {
  readonly categoryId: string
  readonly signals: readonly string[]
  readonly injectionSuspected: boolean
  readonly preRuleP0: boolean
  readonly classifiedBy: 'llm' | 'rules'
  readonly customCategoryId?: string | null
  readonly rulesReason?: 'rules_only' | 'llm_failed' | null
}

export interface ReportToSubmit {
  readonly appRef: AppRef
  readonly reportId: string
  readonly subjectExternalId: string
  readonly p0Signal: boolean
  readonly facts?: ReportFacts
}

export interface Services {
  submitReport(report: ReportToSubmit): Promise<void>
  claim(input: CaseRef): Promise<CaseRecord>
  release(input: CaseRef & { readonly force?: boolean }): Promise<CaseRecord>
  decide(input: DecideInput): Promise<Decision>
  correct(input: CorrectInput): Promise<CaseRecord>
  retryActions(input: RetryActionsInput): Promise<CaseRecord>
  confirmAction(appRef: AppRef, actionRequestId: string): Promise<void>
  failAction(appRef: AppRef, actionRequestId: string, reason: string): Promise<void>
  drain(): Promise<number>
}

export interface ServicesOptions {
  readonly bus: EventBus
  readonly clock: Clock
  readonly newCaseId: () => string
  readonly newDecisionId: () => string
  readonly newActionRequestId: () => string
  readonly newEventId: () => string
  readonly cases: Pick<ModerationServiceDeps, 'uow' | 'policy'>
  readonly delivery: Pick<DeliveryServiceDeps, 'uow'>
  readonly triage: TriageDeps
  /** Moderation's and delivery's timers. */
  readonly scheduler: Scheduler
  /** The classify service, or a fixed classifier in its place: case.opened -> case.classified with what it says. */
  readonly classify: ClassifyServiceDeps | ((appRef: AppRef, caseId: string, reportId: string) => Promise<Classification>)
}

export function composeServices(o: ServicesOptions): Services {
  const { bus, clock } = o
  if (typeof o.classify === 'function') {
    const classify = o.classify
    bus.subscribe('classify', ['case.opened.v1'], async (event) => {
      const appRef = appOf(event)
      const { caseId, reportId } = event.data as EventData<'case.opened.v1'>
      const c = await classify(appRef, caseId, reportId)
      const data = { caseId, reportId, ...c, signals: [...c.signals] }
      await bus.publish({ id: `case.classified:${caseId}`, type: currentType('case.classified'), key: caseId, data, appRef })
    })
  } else {
    subscribeClassify(bus, o.classify)
  }
  subscribeTriage(bus, o.triage)
  const cases: ModerationServiceDeps = { ...o.cases, clock, newCaseId: o.newCaseId, newDecisionId: o.newDecisionId, newEventId: o.newEventId }
  subscribeModeration(bus, cases, o.scheduler)
  const delivery: DeliveryServiceDeps = { ...o.delivery, clock, newActionRequestId: o.newActionRequestId, newEventId: o.newEventId }
  subscribeDelivery(bus, delivery, o.scheduler)
  const work = moderationService(cases)
  const settlement = actionSettlement(delivery)
  return {
    async submitReport(report) {
      const { appRef, facts, ...data } = report
      await bus.publish({ id: `report.received:${report.reportId}`, type: currentType('report.received'), key: report.reportId, data: { ...data, ...(facts && { facts }) }, appRef })
    },
    ...work,
    confirmAction: settlement.confirm,
    failAction: settlement.fail,
    drain: () => bus.drain(),
  }
}

const actionKey = (key: string): PolicyActionKey => ({ key, label: { en: key, id: null }, description: null, reverseKey: null, autoAllowed: false, categories: ['*'] })

/** A policy whose action keys every global category allows. */
export const policyWithKeys = (...keys: string[]): Policy => ({ ...DEFAULT_POLICY, actionKeys: keys.map(actionKey) })

/** Triage's record of each case in memory. */
export class MemoryTriageCases implements TriageCaseStore {
  readonly rows = new Map<string, TriageCase>()
  async find(_t: AppRef, caseId: string) {
    const r = this.rows.get(caseId)
    return r ? structuredClone(r) : null
  }
  async open(r: TriageCase) {
    if (!this.rows.has(r.caseId)) this.rows.set(r.caseId, structuredClone(r))
  }
  async attach(_t: AppRef, caseId: string, reportId: string, facts: Parameters<TriageCaseStore['attach']>[3]) {
    const r = this.rows.get(caseId)
    if (!r) return false
    if (r.reportIds.includes(reportId)) return true
    this.rows.set(caseId, { ...r, reportIds: [...r.reportIds, reportId], reports: facts ? [...r.reports, { reportId, ...facts }] : r.reports })
    return true
  }
  async change(_t: AppRef, caseId: string, change: Parameters<TriageCaseStore['change']>[2]) {
    const r = this.rows.get(caseId)
    if (!r) return false
    this.rows.set(caseId, { ...r, ...change })
    return true
  }  async eraseAccount(_t: AppRef, externalId: string, erasedId: string) {
    let n = 0
    for (const [id, r] of this.rows) {
      const erased = erasedFromCase(r, externalId, erasedId)
      if (erased) (this.rows.set(id, erased), n++)
    }
    return n
  }
}
