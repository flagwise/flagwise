// Classify on the bus: it keeps what flagging's pre-rules found in each report and its copy of the
// app's policy, classifies each new case and publishes case.classified, and asks the LLM again,
// with growing waits, for a case rules classified because the LLM failed.

import { currentType, erasedId, erasureAnswer, policyCategory, policyIn, type EventData, type Policy } from '@flagwise/contracts'
import { subscribeCopy, tenantOf, type DocumentCopy, type EventBus } from '@flagwise/platform'
import { classifyCase, recordScreening, retryClassification } from './classify-case.ts'
import type { ClassificationRecord, ClassifyDeps } from './ports.ts'

/** 5, 10, 20, 40, 80 and 160 minutes: the last retry comes about 5 h 15 min after the LLM failed. */
export const LLM_RETRY_DELAYS_MS: readonly number[] = [5, 10, 20, 40, 80, 160].map((m) => m * 60_000)

export interface ClassifyServiceDeps {
  /** classify's deps, with the app's policy read from `policy` (classifyDepsWithPolicy). */
  readonly classify: ClassifyDeps
  /** Classify's copy of each app's policy, kept from policy.updated. */
  readonly policy: DocumentCopy<Policy>
  /** Waits before each LLM retry, in order; default LLM_RETRY_DELAYS_MS. Each is jittered by up to 20% either way. */
  readonly llmRetryDelaysMs?: readonly number[]
  /** 0 <= x < 1, for the jitter; default Math.random. */
  readonly random?: () => number
}

/** `deps` reading the app's policy from classify's copy: a rules-only app never calls the LLM, and a reporter's pick is looked up among the app's categories. */
export function classifyDepsWithPolicy(deps: Omit<ClassifyDeps, 'llmEnabled' | 'categories'>, policy: DocumentCopy<Policy>): ClassifyDeps {
  return {
    ...deps,
    llmEnabled: async (tenant) => !(await policyIn(policy, tenant)).llm.rulesOnly,
    categories: { find: async (tenant, key) => policyCategory(await policyIn(policy, tenant), key) },
  }
}

/**
 * Subscribes classify's groups (event -> effect):
 * - 'classify.policy': policy.updated -> its copy of the app's policy (first).
 * - 'classify.screenings': report.received -> recordScreening with its P0 signals, injection flag
 *   accounts and evidence ref; a report.received from before 1.1.0 carries none of them and is
 *   skipped, and one from 1.1.0 without the ref gets the place flagging wrote snapshots to then.
 * - 'classify.erasure': subject.erasure_requested -> the account's id replaced in its reports'
 *   screenings and their classifications' LLM summaries dropped; answers erased, or nothing_held.
 * - 'classify': case.opened -> classifyCase with the case and its report, then case.classified
 *   (id `case.classified:{caseId}`) with the classification's facts and no summary.
 * - 'classify.retry': case.classified by rules because the LLM
 *   failed -> after each delay of llmRetryDelaysMs, retryClassification, until it answers or the
 *   delays run out (then the case keeps what it has). The bus's retries do the waiting: the first
 *   delivery only starts the wait, a failed retry throws, and the last one ends quietly. An answer
 *   publishes case.reclassified (id `case.reclassified:{caseId}`); triage takes it from there.
 */
export function subscribeClassify(bus: EventBus, deps: ClassifyServiceDeps): void {
  const { classify } = deps
  subscribeCopy(bus, 'classify.policy', 'policy.updated.v1', deps.policy, (d) => {
    const u = d as EventData<'policy.updated.v1'>
    return { version: u.version, document: u.policy }
  })

  bus.subscribe('classify.screenings', ['report.received.v1'], async (event) => {
    const r = event.data as EventData<'report.received.v1'>
    if (r.p0Signals === undefined || r.injectionSuspected === undefined) return
    await recordScreening(classify, {
      tenant: tenantOf(event),
      reportId: r.reportId,
      p0Signals: r.p0Signals,
      injectionSuspected: r.injectionSuspected,
      reportedExternalId: r.subjectExternalId,
      reporterExternalId: r.facts?.reporterExternalId ?? null,
      evidenceRef: r.evidenceRef ?? `apps/${tenantOf(event).appId}/${r.reportId}`,
    })
  })

  bus.subscribe('classify.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const tenant = tenantOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    const had = await classify.run(tenant, (store) => store.eraseAccount(tenant, request.subjectExternalId, erasedId(request.erasureId)))
    // Published after the erase commits; should it be lost, the redelivery finds nothing left and answers nothing_held.
    await bus.publish({ ...erasureAnswer(request, 'classify.erasure', had > 0 ? 'erased' : 'nothing_held', classify.clock.now()), tenant })
  })

  bus.subscribe('classify', ['case.opened.v1'], async (event) => {
    const tenant = tenantOf(event)
    const { caseId, reportId } = event.data as EventData<'case.opened.v1'>
    const record = await classifyCase(classify, { tenant, caseId, reportId })
    await bus.publish({ id: `case.classified:${caseId}`, type: currentType('case.classified'), key: caseId, data: factsOf(record), tenant })
  })

  const delays = deps.llmRetryDelaysMs ?? LLM_RETRY_DELAYS_MS
  const random = deps.random ?? Math.random
  const jittered = (attempt: number) => (delays[attempt - 1] ?? 0) * (0.8 + 0.4 * random())
  bus.subscribe(
    'classify.retry',
    ['case.classified.v1'],
    async (event, ctx) => {
      const tenant = tenantOf(event)
      const c = event.data as EventData<'case.classified.v1'>
      if (c.rulesReason !== 'llm_failed' || !c.reportId) return
      if (ctx.attempt === 1) throw new Error('Waiting before the first LLM retry')
      const result = await retryClassification(classify, { tenant, caseId: c.caseId, reportId: c.reportId })
      if (result === 'failed') {
        if (ctx.attempt > delays.length) return
        throw new Error('The LLM failed again')
      }
      if (result === null) return
      await bus.publish({ id: `case.reclassified:${c.caseId}`, type: currentType('case.reclassified'), key: c.caseId, data: factsOf(result), tenant })
    },
    { maxAttempts: delays.length + 1, retryDelayMs: jittered },
  )
}

/** The facts of a classification that its events carry: no summary, which stays behind classify's route. */
function factsOf(c: ClassificationRecord): EventData<'case.classified.v1'> {
  return {
    caseId: c.caseId,
    reportId: c.reportId,
    categoryId: c.categoryId,
    customCategoryId: c.customCategoryId,
    signals: [...c.signals],
    injectionSuspected: c.injectionSuspected,
    preRuleP0: c.preRuleP0,
    classifiedBy: c.classifiedBy,
    rulesReason: c.rulesReason,
  }
}
