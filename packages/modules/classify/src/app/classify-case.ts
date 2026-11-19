// Classifying a new case, once: what flagging's pre-rules found, then the install's LLM (small
// model, one repair retry, escalation under the monthly cap), then post-rules. Without an LLM for the install or the app, or
// when it fails, the case is classified by rules. The result is stored, so a repeated run returns it
// without calling the LLM.

import { globalCategory, namesCategory, OTHER_CATEGORY_ID, parseReportSnapshot } from '@flagwise/contracts'
import type { AppRef } from '@flagwise/kernel'
import { buildInput, CLASSIFICATION_SCHEMA } from '../domain/prompt.ts'
import { escalation, validateClassification, type Classification, type ClassificationField } from '../domain/classification.ts'
import { LlmError, type AppCategoryRef, type ClassificationRecord, type ClassifyDeps, type LlmConfig, type LlmUsage, type ReportScreening } from './ports.ts'

export interface ClassifyCaseInput {
  readonly appRef: AppRef
  readonly caseId: string
  /** The report the case was opened with. */
  readonly reportId: string
}

const SMALL_MAX_TOKENS = 4_000
const ESCALATION_MAX_TOKENS = 8_000
const LOW_CONFIDENCE = 0.6
const NO_USAGE: LlmUsage = { input: 0, output: 0, cached: 0 }

/**
 * Classifies the case and stores the result; a case that already has one gets it back and the LLM
 * is not called. LLM calls run outside any transaction.
 *
 * 1. Evidence: the snapshot at the report's evidence ref, as flagging gave it in report.received. A missing or unreadable snapshot throws
 *    (the event is redelivered, then dead-lettered).
 * 2. Pre-rules: the report's screening (recordScreening, from report.received), with its P0
 *    signals and injection_suspected. Without one yet, ScreeningMissingError (the event is
 *    redelivered: the screening is kept by another consumer group and may still be on its way).
 * 3. The LLM, when the install has one and llmEnabled allows the app: the small model answers
 *    (buildInput with `redact` and the reporter's locale, else English). An answer that fails
 *    validateClassification, or names a category outside the global taxonomy, gets one repair
 *    retry; a second bad answer, or any LlmError, ends the LLM attempt.
 * 4. Escalation: escalation() with the answer's confidence, its signals plus the pre-rules' P0
 *    signals, and this month's LLM-classified cases (UTC calendar month, plus this one). When it
 *    escalates, the stronger model answers the same way; if that fails, the small answer stands.
 * 5. Post-rules: signals are the answer's plus the pre-rules' P0 signals, each once; injection is
 *    suspected when either says so; the LLM can never remove a pre-rule signal. lowConfidence when
 *    the standing confidence is below 0.6 or escalation was capped.
 * 6. Rules, when the LLM did not answer: the reporter's picked category when it is a global
 *    category id, else `other` (the pick itself stays in the report), the pre-rules' P0 signals,
 *    no confidence or summary; rulesReason 'rules_only' when the LLM was not called, else
 *    'llm_failed'.
 * 7. The app's category: when `categories` has the reporter's pick, the case's custom category.
 *    Under rules, categoryId becomes the one global category id the pick maps to, else `other`.
 *    With the LLM, the pick stays the custom category only when it maps to the LLM's category (by
 *    id or group; an unmapped pick fits `other`); otherwise customCategoryId is null.
 *
 * When a concurrent run stored first, its record is returned.
 */
export async function classifyCase(deps: ClassifyDeps, input: ClassifyCaseInput): Promise<ClassificationRecord> {
  const { appRef, caseId } = input
  const existing = await deps.run(appRef, (store) => store.find(appRef, caseId))
  if (existing) return existing
  const record = await classifyOnce(deps, input)
  return deps.run(appRef, async (store) => ((await store.insert(record)) ? record : (await store.find(appRef, caseId))!))
}

/**
 * Asks the LLM again for a case that rules classified because the LLM failed (rulesReason
 * 'llm_failed'), and returns the LLM's record once stored in its place. Steps 1 to 5 and 7 of
 * classifyCase run as there; the stored usage adds this run's to the earlier one's.
 *
 * Returns null when there is nothing to retry: no such record, one the LLM classified or rules
 * classified on purpose, no LLM for the install, or llmEnabled turned it off for the app since; also
 * when a concurrent retry stored first. Returns 'failed' when the LLM failed again, storing nothing
 * (the tokens of failed calls are not kept).
 */
export async function retryClassification(deps: ClassifyDeps, input: ClassifyCaseInput): Promise<ClassificationRecord | 'failed' | null> {
  const { appRef, caseId } = input
  const existing = await deps.run(appRef, (store) => store.find(appRef, caseId))
  if (existing?.classifiedBy !== 'rules' || existing.rulesReason !== 'llm_failed') return null
  if (!deps.llm || !(await (deps.llmEnabled?.(appRef) ?? true))) return null
  const fresh = await classifyOnce(deps, input)
  if (fresh.classifiedBy !== 'llm') return 'failed'
  const record = { ...fresh, usage: add(existing.usage, fresh.usage) }
  return deps.run(appRef, async (store) => ((await store.replaceFailed(record)) ? record : null))
}

/** classifyCase found no screening for the report yet. */
export class ScreeningMissingError extends Error {
  constructor(reportId: string) {
    super(`No screening for report ${reportId} yet`)
    this.name = 'ScreeningMissingError'
  }
}

/**
 * Keeps what flagging's pre-rules found in a report (from report.received), for classifyCase.
 * Keeping it again changes nothing.
 */
export async function recordScreening(deps: Pick<ClassifyDeps, 'run'>, screening: ReportScreening): Promise<void> {
  await deps.run(screening.appRef, (store) => store.keepScreening(screening))
}

/** One classification run, steps 1 to 7 of classifyCase, without storing it. */
async function classifyOnce(deps: ClassifyDeps, input: ClassifyCaseInput): Promise<ClassificationRecord> {
  const { appRef } = input
  const pre = await deps.run(appRef, (store) => store.findScreening(appRef, input.reportId))
  if (!pre) throw new ScreeningMissingError(input.reportId)
  const bytes = await deps.snapshots.get(pre.evidenceRef)
  if (!bytes) throw new Error(`No evidence snapshot for report ${input.reportId}`)
  const snapshot = parseReportSnapshot(bytes)
  const picked = (await deps.categories?.find(appRef, snapshot.report.category)) ?? null
  const summaryLanguage = snapshot.report.reporter.locale ?? 'en'

  const llm = deps.llm && (await (deps.llmEnabled?.(appRef) ?? true)) ? deps.llm : undefined
  let usage = NO_USAGE
  const ask = async (config: LlmConfig, model: string, maxTokens: number): Promise<{ value: Classification; model: string }> => {
    let repairFields: readonly ClassificationField[] | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = { model, system: config.prompt.system, schema: CLASSIFICATION_SCHEMA, maxTokens, input: buildInput(snapshot, { redact: deps.redact, summaryLanguage, repairFields }) }
      let response
      try {
        response = await config.provider.complete(request)
      } catch (err) {
        if (err instanceof LlmError && err.usage) usage = add(usage, err.usage)
        throw err
      }
      usage = add(usage, response.usage)
      const checked = validateClassification(response.json)
      const invalid = checked.ok ? (globalCategory(checked.value.categoryId) ? [] : (['category_id'] as const)) : checked.invalid
      if (checked.ok && invalid.length === 0) return { value: checked.value, model: response.model }
      repairFields = invalid
    }
    throw new LlmError({ kind: 'invalid_output' }, `The model gave invalid output twice: ${repairFields!.join(', ')}`)
  }

  let answer: { value: Classification; model: string; escalated: boolean; capped: boolean } | null = null
  if (llm) {
    try {
      const small = await ask(llm, llm.model, SMALL_MAX_TOKENS)
      const now = deps.clock.now()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      const counts = await deps.run(appRef, (store) => store.monthCounts(appRef, monthStart))
      const wanted = escalation({
        confidence: small.value.confidence,
        signals: [...small.value.signals, ...pre.p0Signals],
        monthCases: counts.cases + 1,
        monthEscalations: counts.escalations,
        ...(deps.escalationCapPercent === undefined ? {} : { capPercent: deps.escalationCapPercent }),
      })
      answer = { ...small, escalated: false, capped: wanted.capped }
      if (wanted.escalate) {
        try {
          answer = { ...(await ask(llm, llm.escalationModel, ESCALATION_MAX_TOKENS)), escalated: true, capped: false }
        } catch (err) {
          if (!(err instanceof LlmError)) throw err
        }
      }
    } catch (err) {
      if (!(err instanceof LlmError)) throw err
    }
  }

  const record: ClassificationRecord =
    answer && llm
      ? {
          ...input,
          categoryId: answer.value.categoryId,
          customCategoryId: picked && fits(picked, answer.value.categoryId) ? picked.key : null,
          confidence: answer.value.confidence,
          signals: unique([...answer.value.signals, ...pre.p0Signals]),
          summary: answer.value.summary,
          injectionSuspected: pre.injectionSuspected || answer.value.injectionSuspected,
          preRuleP0: pre.p0Signals.length > 0,
          classifiedBy: 'llm',
          rulesReason: null,
          model: answer.model,
          promptHash: llm.prompt.hash,
          escalated: answer.escalated,
          escalationCapped: answer.capped,
          lowConfidence: answer.capped || answer.value.confidence < LOW_CONFIDENCE,
          usage,
          classifiedAt: deps.clock.now(),
        }
      : rulesRecord(input, snapshot.report.category, picked, pre, llm ? 'llm_failed' : 'rules_only', usage, deps.clock.now())
  return record
}

/** True when the app category maps to the global category, by id or group; an unmapped one fits only `other`. */
function fits(category: AppCategoryRef, categoryId: string): boolean {
  return category.mapsTo.length === 0 ? categoryId === OTHER_CATEGORY_ID : namesCategory(category.mapsTo, categoryId)
}

/** The one global category id an app category maps to, else `other`. */
function globalOf(category: AppCategoryRef): string {
  const only = category.mapsTo.length === 1 ? globalCategory(category.mapsTo[0]!) : undefined
  return only?.id ?? OTHER_CATEGORY_ID
}

function rulesRecord(
  input: ClassifyCaseInput,
  pickedCategory: string,
  picked: AppCategoryRef | null,
  pre: Pick<ReportScreening, 'p0Signals' | 'injectionSuspected'>,
  reason: 'rules_only' | 'llm_failed',
  usage: LlmUsage,
  at: Date,
): ClassificationRecord {
  return {
    ...input,
    categoryId: picked ? globalOf(picked) : (globalCategory(pickedCategory)?.id ?? OTHER_CATEGORY_ID),
    customCategoryId: picked?.key ?? null,
    confidence: null,
    signals: [...pre.p0Signals],
    summary: null,
    injectionSuspected: pre.injectionSuspected,
    preRuleP0: pre.p0Signals.length > 0,
    classifiedBy: 'rules',
    rulesReason: reason,
    model: null,
    promptHash: null,
    escalated: false,
    escalationCapped: false,
    lowConfidence: false,
    usage,
    classifiedAt: at,
  }
}

const add = (a: LlmUsage, b: LlmUsage): LlmUsage => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached })
const unique = (items: readonly string[]) => [...new Set(items)]

/** The classification of a case, or null when it has none yet. */
export function findClassification(deps: Pick<ClassifyDeps, 'run'>, appRef: AppRef, caseId: string): Promise<ClassificationRecord | null> {
  return deps.run(appRef, (store) => store.find(appRef, caseId))
}
