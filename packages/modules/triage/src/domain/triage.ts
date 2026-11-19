// Triage: deterministic rules that turn a classification into severity, priority, SLA due time and
// suggested actions. The same input and config always give the same result; triage never reads the
// system clock and never mutates its input.

import { hasP0Signal, P0_SIGNALS } from '@flagwise/contracts'

export type Severity = 'P0' | 'P1' | 'P2'

export { P0_SIGNALS }

export interface CategoryRule {
  readonly id: string
  readonly severity: Severity
  readonly p0Locked: boolean
  /** Custom SLA for this category's own severity, in hours. */
  readonly slaHours?: number
  readonly suggestedActionKeys: readonly string[]
}

export interface Threshold {
  readonly score: number
  readonly actionKey: string
}

export interface TriageConfig {
  readonly slaHours: Readonly<Record<Severity, number>>
  readonly points: Readonly<Record<Severity, number>>
  readonly reportedNewAccountDays: number
  readonly newReporterHours: number
  readonly newAccountPointMultiplier: number
  readonly thresholds: readonly Threshold[]
}

/** Default SLA targets, points per severity and account-age thresholds; configurable per app. */
export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  slaHours: { P0: 1, P1: 24, P2: 72 },
  points: { P0: 100, P1: 30, P2: 10 },
  reportedNewAccountDays: 7,
  newReporterHours: 24,
  newAccountPointMultiplier: 1.5,
  thresholds: [],
}

export interface TriageInput {
  readonly openedAt: Date
  readonly category: CategoryRule
  readonly classification: {
    readonly signals: readonly string[]
    readonly injectionSuspected: boolean
    readonly preRuleP0: boolean
  }
  readonly reported: {
    readonly accountCreatedAt?: Date | undefined
    readonly violationScore: number
  }
  readonly reporters: readonly {
    readonly accountCreatedAt?: Date | undefined
    /** 0..1, or null while the reporter has too few decided reports (neutral). */
    readonly credibility: number | null
  }[]
}

export type AppliedRule =
  | 'p0_category'
  | 'p0_signal'
  | 'p0_pre_rule'
  | 'reported_new_account'
  | 'reporter_new_account'
  | 'reporter_low_credibility'
  | 'threshold_action'

export type TriageFlag = 'injection_suspected' | 'other_category' | 'reported_age_unknown'

export interface TriageResult {
  readonly severity: Severity
  readonly priority: number
  readonly slaDueAt: Date
  readonly suggestedActionKeys: readonly string[]
  readonly applied: readonly AppliedRule[]
  readonly flags: readonly TriageFlag[]
}

/**
 * Triages one case.
 *
 * Severity (P0 is the most severe, then P1, then P2) is the most severe of: the category's
 * configured severity; P0 when the category is P0-locked (child safety, terrorism, threats,
 * self-harm, sexual exploitation, and custom categories mapped to them; config can never lower
 * these); P0 when any signal is in P0_SIGNALS (other signals never change severity); P0 when
 * `preRuleP0` is true. A suspected prompt injection never changes severity or priority.
 *
 * Account ages are measured at `openedAt`. The reported account is new when `accountCreatedAt` is
 * set and younger than `reportedNewAccountDays` days; a reporter is new when younger than
 * `newReporterHours` hours (strictly). A missing `accountCreatedAt` is neutral.
 *
 * Priority (higher = more urgent) = base + newAccountBoost + scorePart + reportsPart:
 * - base: P0 3000, P1 2000, P2 1000;
 * - newAccountBoost: 100 when the reported account is new;
 * - scorePart: the reported account's violation score, clamped to 0..200;
 * - reportsPart: `Math.round(min(5, sum of reporter weights) * 20)`. Each reporter weighs 1, times
 *   0.5 if new, times `min(1, 0.5 + credibility)` when credibility is not null. On P0 results every
 *   reporter weighs 1.
 * The bands never overlap: no P2 case can outrank a P1 case, nor a P1 case a P0 case.
 *
 * SLA due time = `openedAt` + the category's `slaHours` when set and the final severity equals the
 * category's configured severity, otherwise `config.slaHours[severity]`.
 *
 * Suggested actions: the category's `suggestedActionKeys` in order, then at most one threshold
 * action. `projected = violationScore + Math.round(config.points[severity] * m)`, with
 * `m = newAccountPointMultiplier` when the reported account is new, else 1. Among thresholds with
 * `violationScore < threshold.score <= projected`, the highest one's actionKey is appended unless
 * already listed.
 *
 * `applied` lists the rules that applied, in this order: p0_category, p0_signal, p0_pre_rule,
 * reported_new_account, reporter_new_account, reporter_low_credibility, threshold_action (whether or
 * not its key was already suggested). The two reporter rules never appear on P0 results.
 *
 * `flags`, in order: injection_suspected, other_category (category id 'other'),
 * reported_age_unknown (no `accountCreatedAt` on the reported account).
 */
export function triage(input: TriageInput, config: TriageConfig = DEFAULT_TRIAGE_CONFIG): TriageResult {
  const { category, classification, reported } = input
  const opened = input.openedAt.getTime()
  const applied: AppliedRule[] = []

  const p0Category = category.p0Locked || category.severity === 'P0'
  const p0Signal = hasP0Signal(classification.signals)
  const p0PreRule = classification.preRuleP0
  if (p0Category) applied.push('p0_category')
  if (p0Signal) applied.push('p0_signal')
  if (p0PreRule) applied.push('p0_pre_rule')

  const isP0 = p0Category || p0Signal || p0PreRule
  const severity: Severity = isP0 ? 'P0' : category.severity

  const reportedNew =
    reported.accountCreatedAt !== undefined &&
    opened - reported.accountCreatedAt.getTime() < config.reportedNewAccountDays * DAY_MS
  if (reportedNew) applied.push('reported_new_account')

  let weightSum = 0
  let anyNewReporter = false
  let anyLowCredibility = false
  for (const reporter of input.reporters) {
    let weight = 1
    if (!isP0) {
      const isNew =
        reporter.accountCreatedAt !== undefined &&
        opened - reporter.accountCreatedAt.getTime() < config.newReporterHours * HOUR_MS
      if (isNew) {
        weight *= 0.5
        anyNewReporter = true
      }
      if (reporter.credibility !== null) {
        const factor = Math.min(1, 0.5 + reporter.credibility)
        if (factor < 1) anyLowCredibility = true
        weight *= factor
      }
    }
    weightSum += weight
  }
  if (anyNewReporter) applied.push('reporter_new_account')
  if (anyLowCredibility) applied.push('reporter_low_credibility')

  const priority =
    BASE_PRIORITY[severity] +
    (reportedNew ? 100 : 0) +
    Math.min(200, Math.max(0, reported.violationScore)) +
    Math.round(Math.min(5, weightSum) * 20)

  const slaHours = category.slaHours !== undefined && severity === category.severity ? category.slaHours : config.slaHours[severity]

  const suggestedActionKeys = [...category.suggestedActionKeys]
  const projected = reported.violationScore + Math.round(config.points[severity] * (reportedNew ? config.newAccountPointMultiplier : 1))
  const crossed = config.thresholds
    .filter((t) => reported.violationScore < t.score && t.score <= projected)
    .reduce<Threshold | undefined>((best, t) => (best === undefined || t.score > best.score ? t : best), undefined)
  if (crossed) {
    applied.push('threshold_action')
    if (!suggestedActionKeys.includes(crossed.actionKey)) suggestedActionKeys.push(crossed.actionKey)
  }

  const flags: TriageFlag[] = []
  if (classification.injectionSuspected) flags.push('injection_suspected')
  if (category.id === 'other') flags.push('other_category')
  if (reported.accountCreatedAt === undefined) flags.push('reported_age_unknown')

  return {
    severity,
    priority,
    slaDueAt: new Date(opened + slaHours * HOUR_MS),
    suggestedActionKeys,
    applied,
    flags,
  }
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const BASE_PRIORITY: Record<Severity, number> = { P0: 3000, P1: 2000, P2: 1000 }
