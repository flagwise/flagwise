// Triage on the bus. It keeps its own record of each case from the cases' events (all keyed by the
// case, so they reach it in the order they were published), triages a case once classify has
// classified it, again when the LLM answers for a case rules classified while no moderator has
// worked on it, and again on a moderator's correction. It publishes case.triaged or
// case.untriaged; moderation saves them on the case.

import { currentType, erasedId, erasureAnswer, policyIn, type EventData } from '@flagwise/contracts'
import type { AppRef } from '@flagwise/kernel'
import { subscribeCopy, appOf, type BusEvent, type EventBus, type Work } from '@flagwise/platform'
import { triageCase } from './case-triage.ts'
import type { Severity } from '../domain/triage.ts'
import type { ReportAccounts, TriageCase, TriageClassification, TriageDeps, TriageStores } from './ports.ts'

/** The cases' events triage keeps its record from, and the classifications it triages. */
export const TRIAGE_EVENT_TYPES = [
  'case.opened.v1',
  'case.report_attached.v1',
  'case.classified.v1',
  'case.reclassified.v1',
  'case.claimed.v1',
  'case.released.v1',
  'case.corrected.v1',
  'case.corrected.v2',
  'case.decided.v1',
] as const

type Classified = EventData<'case.classified.v1'>
type Cause = NonNullable<EventData<'case.triaged.v1'>['cause']>

/**
 * Subscribes triage's groups (event -> effect):
 * - 'triage.policy': policy.updated -> its copy of the app's policy (first, so a poll brings it up
 *   to date before 'triage' reads it).
 * - 'triage': the cases' events -> its record of each case, and:
 *   - case.classified, for a case still classifying: when the LLM failed and the app's policy does
 *     not fall back to rules, case.untriaged (reason provider_error); otherwise triageCase with
 *     the case's opened time, the classification and the facts of its reports so far, and
 *     case.triaged with the case's reports and the classification's facts. The classification
 *     is kept as the one the case was triaged on.
 *   - case.reclassified (the LLM answered after it had failed): triaged again and case.triaged
 *     published again (id `case.triaged:{caseId}:llm_retry`) when no moderator holds, corrected or
 *     decided the case, and an untriaged case was never claimed. Otherwise the case keeps what it
 *     has.
 *   - case.corrected (v2): the moderator's category on the kept classification (a new one drops
 *     the app's category), then triaged again with the moderator's severity when given, and
 *     case.triaged (cause correction, id `case.triaged:{correction's event id}`). A v1 correction,
 *     from a release that triaged it itself, only marks the case corrected with its category.
 *   A classification for a case triage has no record of, or a correction of a case it has no
 *   classification of, throws, so it is retried and then dead-lettered.
 * - 'triage.erasure': subject.erasure_requested -> the account erased from the kept cases (its id
 *   replaced, its account ages dropped); answers erased, or nothing_held.
 */
export function subscribeTriage(bus: EventBus, deps: TriageDeps): void {
  subscribeCopy(bus, 'triage.policy', 'policy.updated.v1', deps.policy, (d) => {
    const u = d as EventData<'policy.updated.v1'>
    return { version: u.version, document: u.policy }
  })
  bus.subscribe('triage.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const appRef = appOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await deps.uow.run(appRef, async (w) => {
      const had = await w.stores.cases.eraseAccount(appRef, request.subjectExternalId, erasedId(request.erasureId))
      await w.publish(erasureAnswer(request, 'triage.erasure', had > 0 ? 'erased' : 'nothing_held', new Date()))
    })
  })
  bus.subscribe('triage', TRIAGE_EVENT_TYPES, async (event) => {
    const appRef = appOf(event)
    await deps.uow.run(appRef, (w) => handle(deps, w, appRef, event))
  })
}

async function handle(deps: TriageDeps, w: Work<TriageStores>, appRef: AppRef, event: BusEvent): Promise<void> {
  const cases = w.stores.cases
  switch (event.type) {
    case 'case.opened.v1': {
      const d = event.data as EventData<'case.opened.v1'>
      await cases.open({
        appRef,
        caseId: d.caseId,
        subjectExternalId: d.subjectExternalId,
        openedAt: new Date(d.occurredAt),
        reportIds: [d.reportId],
        reports: d.facts ? [accountsOf(d.reportId, d.facts)] : [],
        state: 'classifying',
        classification: null,
        claimed: false,
        everClaimed: false,
        corrected: false,
        decided: false,
      })
      return
    }
    case 'case.report_attached.v1': {
      const d = event.data as EventData<'case.report_attached.v1'>
      const facts = d.facts ? accountsOf(d.reportId, d.facts) : null
      await cases.attach(appRef, d.caseId, d.reportId, facts && { reporterExternalId: facts.reporterExternalId, reporterAccountCreatedAt: facts.reporterAccountCreatedAt, reportedAccountCreatedAt: facts.reportedAccountCreatedAt })
      return
    }
    case 'case.claimed.v1':
      await cases.change(appRef, (event.data as EventData<'case.claimed.v1'>).caseId, { claimed: true, everClaimed: true })
      return
    case 'case.released.v1':
      await cases.change(appRef, (event.data as EventData<'case.released.v1'>).caseId, { claimed: false })
      return
    case 'case.corrected.v1': {
      const d = event.data as EventData<'case.corrected.v1'>
      const record = await cases.find(appRef, d.caseId)
      if (!record) return
      await cases.change(appRef, d.caseId, { corrected: true, ...(record.classification && { classification: corrected(record.classification, d.after.categoryId) }) })
      return
    }
    case 'case.corrected.v2': {
      const d = event.data as EventData<'case.corrected.v2'>
      const record = await cases.find(appRef, d.caseId)
      if (!record?.classification) throw new Error(`Triage has no classification of case ${d.caseId}`)
      if (record.decided) return
      const classification = corrected(record.classification, d.after.categoryId)
      await cases.change(appRef, d.caseId, { corrected: true })
      await publishTriaged(deps, w, record, classification, `case.triaged:${event.id}`, 'correction', d.after.severity ?? undefined)
      return
    }
    case 'case.decided.v1':
      await cases.change(appRef, (event.data as EventData<'case.decided.v1'>).caseId, { decided: true, claimed: false })
      return
    case 'case.classified.v1': {
      const c = event.data as Classified
      const record = await cases.find(appRef, c.caseId)
      if (!record) throw new Error(`Triage has no record of case ${c.caseId}`)
      if (record.state !== 'classifying') return
      const policy = await policyIn(deps.policy, appRef)
      const classification = classificationOf(c)
      if (c.rulesReason === 'llm_failed' && !policy.llm.fallbackToRules) {
        await cases.change(appRef, c.caseId, { state: 'untriaged', classification })
        await w.publish({ id: `case.untriaged:${c.caseId}`, type: currentType('case.untriaged'), key: c.caseId, data: { caseId: c.caseId, reason: 'provider_error' } })
        return
      }
      await publishTriaged(deps, w, record, classification, `case.triaged:${c.caseId}`, 'classification')
      return
    }
    case 'case.reclassified.v1': {
      const c = event.data as Classified
      const record = await cases.find(appRef, c.caseId)
      if (!record || record.claimed || record.corrected || record.decided) return
      if (record.state === 'classifying' || (record.state === 'untriaged' && record.everClaimed)) return
      await publishTriaged(deps, w, record, classificationOf(c), `case.triaged:${c.caseId}:llm_retry`, 'llm_retry')
      return
    }
  }
}

/** Triages the case on `c` (with a moderator's severity when given), keeps `c` as its classification and publishes case.triaged. */
async function publishTriaged(deps: TriageDeps, w: Work<TriageStores>, record: TriageCase, c: TriageClassification, id: string, cause: Cause, severity?: Severity): Promise<void> {
  const customCategoryId = c.customCategoryId
  const result = triageCase({
    openedAt: record.openedAt,
    policy: await policyIn(deps.policy, record.appRef),
    categoryId: c.categoryId,
    customCategoryId,
    severity,
    classification: c,
    reports: record.reports,
    ...(deps.config && { config: deps.config }),
  })
  await w.stores.cases.change(record.appRef, record.caseId, { state: 'triaged', classification: c })
  const data: EventData<'case.triaged.v1'> = {
    caseId: record.caseId,
    reportIds: [...record.reportIds],
    categoryId: c.categoryId,
    customCategoryId,
    signals: [...c.signals],
    injectionSuspected: c.injectionSuspected,
    classifiedBy: c.classifiedBy,
    severity: result.severity,
    priority: result.priority,
    slaDueAt: result.slaDueAt.toISOString(),
    suggestedActionKeys: [...result.suggestedActionKeys],
    applied: [...result.applied],
    flags: [...result.flags],
    cause,
  }
  await w.publish({ id, type: currentType('case.triaged'), key: record.caseId, data })
}

/** The facts of a classification triage triages on. */
function classificationOf(c: Classified): TriageClassification {
  return {
    categoryId: c.categoryId,
    customCategoryId: c.customCategoryId ?? null,
    signals: [...c.signals],
    injectionSuspected: c.injectionSuspected,
    preRuleP0: c.preRuleP0,
    classifiedBy: c.classifiedBy,
  }
}

/** The classification with a moderator's category: a new category drops the app's own. */
function corrected(c: TriageClassification, categoryId: string): TriageClassification {
  return categoryId === c.categoryId ? c : { ...c, categoryId, customCategoryId: null }
}

/** Account facts from an event, whose times are ISO strings once they went through a bus. */
function accountsOf(reportId: string, f: { readonly reporterExternalId: string; readonly reporterAccountCreatedAt: string | Date | null; readonly reportedAccountCreatedAt: string | Date | null }): ReportAccounts {
  const time = (v: string | Date | null) => (v === null ? null : new Date(v))
  return { reportId, reporterExternalId: f.reporterExternalId, reporterAccountCreatedAt: time(f.reporterAccountCreatedAt), reportedAccountCreatedAt: time(f.reportedAccountCreatedAt) }
}
