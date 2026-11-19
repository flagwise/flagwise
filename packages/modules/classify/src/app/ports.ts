// What classify needs from the outside: the install's LLM, its own classification store, read
// access to evidence snapshots, and whether an app may use the LLM.

import type { Clock, TenantRef } from '@flagwise/kernel'
import type { ObjectStorage } from '@flagwise/platform'
import type { LlmFailure } from '../domain/classification.ts'
import type { ClassifierPrompt } from '../domain/prompt.ts'

export interface LlmUsage {
  /** Input tokens billed at the full rate, including tokens written to the cache. */
  readonly input: number
  readonly output: number
  /** Input tokens read from the cache. */
  readonly cached: number
}

export interface LlmRequest {
  readonly model: string
  /** The fixed system prompt; providers that cache prompts cache it. */
  readonly system: string
  readonly input: string
  /** JSON schema of the answer. */
  readonly schema: Readonly<Record<string, unknown>>
  readonly maxTokens: number
}

export interface LlmResponse {
  /** The parsed JSON answer; validateClassification checks it. */
  readonly json: unknown
  readonly usage: LlmUsage
  /** The model that answered, as the provider reports it. */
  readonly model: string
}

/** One LLM API. complete() throws an LlmError for every failure it can name. */
export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>
}

/** A failed LLM call. `usage` is what the failed call still cost, when known. */
export class LlmError extends Error {
  readonly failure: LlmFailure
  readonly usage: LlmUsage | undefined

  constructor(failure: LlmFailure, message: string, usage?: LlmUsage) {
    super(message)
    this.name = 'LlmError'
    this.failure = failure
    this.usage = usage
  }
}

/** The install's LLM, set once for the whole install: its provider, two models and prompt. */
export interface LlmConfig {
  readonly provider: LlmProvider
  /** The small model every case starts with. */
  readonly model: string
  /** The stronger model for escalation. */
  readonly escalationModel: string
  readonly prompt: ClassifierPrompt
}

export type ClassifiedBy = 'llm' | 'rules'

/** Why a case was classified by rules: no LLM for the install or the app, or the LLM failed. */
export type RulesReason = 'rules_only' | 'llm_failed'

/** The classification of one case, as classify stores it. */
export interface ClassificationRecord {
  readonly tenant: TenantRef
  readonly caseId: string
  /** The report the case was opened with, whose evidence was classified. */
  readonly reportId: string
  /**
   * A global category id from the LLM. Under rules: the global category the reporter's pick maps to
   * (`other` when it maps to none, several or a group), or the pick itself when the app has no such
   * category.
   */
  readonly categoryId: string
  /** The app's category of the case: the reporter's pick, when the app has it and it fits categoryId. */
  readonly customCategoryId: string | null
  /** Null under rules. */
  readonly confidence: number | null
  /** LLM signals plus the pre-rules' P0 signals, each once. */
  readonly signals: readonly string[]
  /** Null under rules. Derived from evidence, so it stays in classify and never goes into events. */
  readonly summary: string | null
  readonly injectionSuspected: boolean
  /** The pre-rules found a P0 signal. */
  readonly preRuleP0: boolean
  readonly classifiedBy: ClassifiedBy
  /** Null when the LLM classified. */
  readonly rulesReason: RulesReason | null
  /** The model whose answer stands. */
  readonly model: string | null
  /** ClassifierPrompt.hash of the system prompt the model was given; null under rules. */
  readonly promptHash: string | null
  readonly escalated: boolean
  /** Escalation was wanted but the month's cap was reached. */
  readonly escalationCapped: boolean
  /** Confidence below 0.6 with no stronger answer, or escalation capped. */
  readonly lowConfidence: boolean
  /** Tokens of every LLM call made for this case, failed ones included when known. */
  readonly usage: LlmUsage
  readonly classifiedAt: Date
}

/** What flagging's pre-rules found in one report, as classify keeps it from report.received. */
export interface ReportScreening {
  readonly tenant: TenantRef
  readonly reportId: string
  /** The P0 signals found, in P0_SIGNALS order, each once. */
  readonly p0Signals: readonly string[]
  readonly injectionSuspected: boolean
  /** The reported account and the reporter, for finding an account's reports when it is erased. */
  readonly reportedExternalId?: string | null
  readonly reporterExternalId?: string | null
}

/** Classification access inside one tenant transaction. */
export interface ClassificationStore {
  find(tenant: TenantRef, caseId: string): Promise<ClassificationRecord | null>
  /** Stores the record; false, writing nothing, when the case already has one. */
  insert(record: ClassificationRecord): Promise<boolean>
  /**
   * Replaces the case's record with `record`, only while the stored one was classified by rules
   * because the LLM failed; false, writing nothing, otherwise.
   */
  replaceFailed(record: ClassificationRecord): Promise<boolean>
  /** LLM-classified cases of the tenant's app and mode since `since`, and how many of them escalated. */
  monthCounts(tenant: TenantRef, since: Date): Promise<{ readonly cases: number; readonly escalations: number }>
  /** Keeps a report's screening; one already kept for the report stays as it is. */
  keepScreening(screening: ReportScreening): Promise<void>
  findScreening(tenant: TenantRef, reportId: string): Promise<ReportScreening | null>
  /**
   * Erases an account: replaces its id with `erasedId` in the screenings of its reports (as
   * reported or reporter) and drops the LLM summary of the classifications made from those
   * reports. Returns how many reports it had.
   */
  eraseAccount(tenant: TenantRef, externalId: string, erasedId: string): Promise<number>
}

export interface ClassifyDeps {
  /** Runs `fn` in one transaction for the tenant. */
  run<R>(tenant: TenantRef, fn: (store: ClassificationStore) => Promise<R>): Promise<R>
  /** Evidence snapshots, read only. */
  readonly snapshots: Pick<ObjectStorage, 'get'>
  readonly clock: Clock
  /** The install's LLM; without one every case is classified by rules. */
  readonly llm?: LlmConfig | undefined
  /** Whether the app may send evidence to the LLM (default: every app may). */
  llmEnabled?(tenant: TenantRef): Promise<boolean>
  /** Redact PII from the text sent to the LLM. */
  readonly redact: boolean
  /** Percent of the month's cases that may escalate (default 15). */
  readonly escalationCapPercent?: number
  /** The app's categories, which a reporter's pick names (default: the app has none). */
  readonly categories?: AppCategories
}

/** An app's own category, as classify reads it. */
export interface AppCategoryRef {
  readonly key: string
  /** Global groups or global category ids; empty when unmapped. */
  readonly mapsTo: readonly string[]
}

export interface AppCategories {
  /** The app's current category with this key, or null. */
  find(tenant: TenantRef, key: string): Promise<AppCategoryRef | null>
}
