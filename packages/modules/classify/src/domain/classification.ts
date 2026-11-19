// Checking LLM output, deciding escalation and timing LLM retries.

import { P0_SIGNALS } from '@flagwise/contracts'

export { P0_SIGNALS }

export interface Classification {
  readonly categoryId: string
  readonly customCategoryId: string | null
  readonly confidence: number
  readonly signals: readonly string[]
  readonly summary: string
  readonly injectionSuspected: boolean
}

export type ClassificationField =
  | 'category_id'
  | 'custom_category_id'
  | 'confidence'
  | 'signals'
  | 'summary'
  | 'injection_suspected'

export type ValidationResult =
  | { readonly ok: true; readonly value: Classification }
  | { readonly ok: false; readonly invalid: readonly ClassificationField[] }

/** Why an LLM call failed. */
export interface LlmFailure {
  readonly kind: 'auth' | 'rate_limited' | 'server' | 'timeout' | 'invalid_output' | 'bad_request'
}

export interface EscalationInput {
  readonly confidence: number
  readonly signals: readonly string[]
  readonly monthCases: number
  readonly monthEscalations: number
  readonly capPercent?: number
}

export interface EscalationDecision {
  readonly escalate: boolean
  readonly reason: 'p0_signal' | 'low_confidence' | null
  readonly capped: boolean
}

/**
 * Checks the model's structured output. Fields: category_id (string, 1-128); custom_category_id
 * (string of 1-128, null or missing); confidence (finite number, 0 to 1); signals (array of at most
 * 20 non-empty strings); summary (string of at most 400 characters); injection_suspected (boolean).
 * Extra fields are ignored. Returns the camelCase value (customCategoryId null when missing), or the
 * names of the invalid fields in that order; a value that is not a plain object makes every field
 * invalid.
 */
export function validateClassification(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, invalid: ['category_id', 'custom_category_id', 'confidence', 'signals', 'summary', 'injection_suspected'] }
  }
  const o = raw as Record<string, unknown>
  const idOk = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 128

  const invalid: ClassificationField[] = []
  if (!idOk(o.category_id)) invalid.push('category_id')
  if (!(o.custom_category_id === undefined || o.custom_category_id === null || idOk(o.custom_category_id))) invalid.push('custom_category_id')
  if (!(typeof o.confidence === 'number' && Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1)) invalid.push('confidence')
  if (!(Array.isArray(o.signals) && o.signals.length <= 20 && o.signals.every((x) => typeof x === 'string' && x.length > 0))) invalid.push('signals')
  if (!(typeof o.summary === 'string' && o.summary.length <= 400)) invalid.push('summary')
  if (typeof o.injection_suspected !== 'boolean') invalid.push('injection_suspected')
  if (invalid.length > 0) return { ok: false, invalid }

  return {
    ok: true,
    value: {
      categoryId: o.category_id as string,
      customCategoryId: (o.custom_category_id as string | null | undefined) ?? null,
      confidence: o.confidence as number,
      signals: o.signals as string[],
      summary: o.summary as string,
      injectionSuspected: o.injection_suspected as boolean,
    },
  }
}

/**
 * Whether to re-run on the stronger model. Wanted on any P0 signal (reason 'p0_signal', which wins)
 * or confidence below 0.6 ('low_confidence'). Allowed while `monthEscalations * 100 < capPercent *
 * monthCases`, where monthCases counts this month's classified cases including this one; whole
 * numbers only, so a 15% cap allows exactly 15 of 100 and the first case of a month can always
 * escalate. Wanted but over the cap: `{ escalate: false, reason, capped: true }` (the small-model
 * result stands, marked low confidence). monthCases must be an integer >= 1, monthEscalations an
 * integer >= 0 and capPercent an integer from 1 to 100, else RangeError.
 */
export function escalation(input: EscalationInput): EscalationDecision {
  const capPercent = input.capPercent ?? 15
  if (!Number.isInteger(input.monthCases) || input.monthCases < 1) throw new RangeError('monthCases must be an integer >= 1')
  if (!Number.isInteger(input.monthEscalations) || input.monthEscalations < 0) throw new RangeError('monthEscalations must be an integer >= 0')
  if (!Number.isInteger(capPercent) || capPercent < 1 || capPercent > 100) throw new RangeError('capPercent must be an integer from 1 to 100')

  const reason = input.signals.some((s) => (P0_SIGNALS as readonly string[]).includes(s))
    ? 'p0_signal'
    : input.confidence < 0.6
      ? 'low_confidence'
      : null
  if (reason === null) return { escalate: false, reason: null, capped: false }

  const allowed = input.monthEscalations * 100 < capPercent * input.monthCases
  return { escalate: allowed, reason, capped: !allowed }
}

/** After the LLM failed, LLM classify is retried every 15 minutes for 6 hours (slots firstFailedAt + k * 15 min, k = 1..24). Returns the first slot strictly after now, or null. */
export function nextClassifyRetry(firstFailedAt: Date, now: Date): Date | null {
  const SLOT_MS = 15 * 60_000
  const elapsed = now.getTime() - firstFailedAt.getTime()
  const k = Math.max(1, Math.floor(elapsed / SLOT_MS) + 1)
  return k > 24 ? null : new Date(firstFailedAt.getTime() + k * SLOT_MS)
}
