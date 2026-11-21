// In-memory fakes for classify's ports: a scripted LLM, the classification store, a report snapshot.
import { REPORT_SNAPSHOT_FORMAT } from '@flagwise/contracts'
import type { AppRef } from '@flagwise/kernel'
import { classifierPrompt, LlmError, type ClassificationRecord, type ClassificationStore, type LlmFailure, type LlmProvider, type LlmRequest, type LlmResponse, type ReportScreening } from '../src/index.ts'

export const A: AppRef = { appId: 'app_a', livemode: true }
export const USAGE = { input: 100, output: 20, cached: 900 }
export const PROMPT = classifierPrompt('You classify user reports.')

export const answer = (over: Record<string, unknown> = {}) => ({
  category_id: 'scams_fraud.romance_scam',
  custom_category_id: null,
  confidence: 0.9,
  signals: ['asking_for_money'],
  summary: 'The reported account asked for $200.',
  injection_suspected: false,
  ...over,
})

export type Step = Record<string, unknown> | LlmFailure

/** Answers each call with the next step: an answer object, or a failure ({ kind }). */
export class ScriptedProvider implements LlmProvider {
  readonly requests: LlmRequest[] = []
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    const step = this.steps.shift()
    if (!step) throw new Error('No scripted answer left')
    if ('kind' in step && typeof step.kind === 'string' && !('category_id' in step)) throw new LlmError(step as LlmFailure, `scripted ${step.kind}`)
    return { json: step, usage: USAGE, model: request.model }
  }
}

export class MemoryStore implements ClassificationStore {
  readonly rows: ClassificationRecord[] = []
  /** Report id -> its screening; rpt_1 was screened and nothing found. */
  readonly screenings = new Map<string, ReportScreening>([['rpt_1', { appRef: A, reportId: 'rpt_1', p0Signals: [], injectionSuspected: false, evidenceRef: 'apps/app_a/rpt_1' }]])
  readonly earlier: { cases: number; escalations: number }
  constructor(earlier = { cases: 0, escalations: 0 }) {
    this.earlier = earlier
  }
  async find(_t: AppRef, caseId: string) {
    return this.rows.find((r) => r.caseId === caseId) ?? null
  }
  async insert(record: ClassificationRecord) {
    if (this.rows.some((r) => r.caseId === record.caseId)) return false
    this.rows.push(record)
    return true
  }
  async replaceFailed(record: ClassificationRecord) {
    const i = this.rows.findIndex((r) => r.caseId === record.caseId && r.classifiedBy === 'rules' && r.rulesReason === 'llm_failed')
    if (i < 0) return false
    this.rows[i] = record
    return true
  }
  async monthCounts() {
    return this.earlier
  }
  async keepScreening(screening: ReportScreening) {
    if (!this.screenings.has(screening.reportId)) this.screenings.set(screening.reportId, screening)
  }
  async findScreening(_t: AppRef, reportId: string) {
    return this.screenings.get(reportId) ?? null
  }
  async eraseAccount(_t: AppRef, externalId: string, erasedId: string) {
    const hit = [...this.screenings.values()].filter((s) => s.reportedExternalId === externalId || s.reporterExternalId === externalId)
    for (const s of hit) {
      const swap = (id: string | null | undefined) => (id === externalId ? erasedId : id)
      this.screenings.set(s.reportId, { ...s, reportedExternalId: swap(s.reportedExternalId) ?? null, reporterExternalId: swap(s.reporterExternalId) ?? null })
    }
    this.rows.forEach((r, i) => {
      if (hit.some((s) => s.reportId === r.reportId)) this.rows[i] = { ...r, summary: null }
    })
    return hit.length
  }
}

export const snapshotBytes = (text: string, content = ['can you send me $200 first?'], category = 'asking_for_money') =>
  new TextEncoder().encode(
    JSON.stringify({
      format: REPORT_SNAPSHOT_FORMAT,
      report_id: 'rpt_1',
      received_at: '2026-11-06T09:00:00.000Z',
      report: {
        reporter: { externalId: 'u_jane_doe' },
        reported: { externalId: 'u_john_doe' },
        category,
        text,
        evidence: { kind: 'message', content: content.map((t) => ({ text: t, author: 'u_john_doe' })), media: [], metadata: {} },
        identifiers: {},
      },
    }),
  )
