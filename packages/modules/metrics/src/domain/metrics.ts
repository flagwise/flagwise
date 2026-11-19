// Operational metrics per app and period.

export type Severity = 'P0' | 'P1' | 'P2'

export interface CaseFacts {
  readonly caseId: string
  readonly livemode: boolean
  readonly severity: Severity
  readonly subjectId: string
  readonly openedAt: Date
  readonly slaDueAt: Date
  /** First claim by a moderator. */
  readonly firstActionAt: Date | null
  readonly decidedAt: Date | null
  /** All requested actions confirmed, or no action needed. */
  readonly resolvedAt: Date | null
  readonly outcome: 'violation' | 'no_violation' | null
  /** null when the case was not classified by the LLM (rules only). */
  readonly llmCategoryId: string | null
  readonly finalCategoryId: string | null
  readonly appeals: readonly { readonly filedAt: Date; readonly outcome: 'upheld' | 'overturned' | null }[]
}

export interface Metrics {
  readonly cases: number
  readonly medianTimeToFirstActionMs: number | null
  readonly medianTimeToResolutionMs: number | null
  readonly slaBreachRate: Readonly<Record<Severity, number | null>>
  readonly repeatOffenderRate: number | null
  readonly appealOverturnRate: number | null
  readonly llmAcceptanceRate: number | null
}

/**
 * Metrics over the cases in the period: livemode true and `from <= openedAt < to` (to must be after
 * from, else RangeError). Test-mode data never counts.
 *
 * - medianTimeToFirstActionMs / medianTimeToResolutionMs: medians over cases that have the
 *   timestamp (the middle value, or the mean of the two middle values; null when none).
 * - slaBreachRate per severity, as of `to`: a case is measured at decidedAt when decided at or
 *   before `to`, otherwise at `to`, and breached when that is after slaDueAt. null with no cases of
 *   that severity.
 * - repeatOffenderRate: among subjects with a 'violation' case in the period, the share with two or
 *   more.
 * - appealOverturnRate: among resolved appeals of the period's cases, the share overturned.
 * - llmAcceptanceRate: among decided cases with both an LLM and a final category, the share where
 *   the moderator kept the LLM's category.
 */
export function computeMetrics(facts: readonly CaseFacts[], period: { readonly from: Date; readonly to: Date }): Metrics {
  const from = period.from.getTime()
  const to = period.to.getTime()
  if (!(to > from)) throw new RangeError('Period end must be after its start')

  const cases = facts.filter((f) => f.livemode && f.openedAt.getTime() >= from && f.openedAt.getTime() < to)

  const breachRate = (severity: Severity) => {
    const ofSeverity = cases.filter((f) => f.severity === severity)
    if (ofSeverity.length === 0) return null
    const breached = ofSeverity.filter((f) => {
      const measuredAt = f.decidedAt !== null && f.decidedAt.getTime() <= to ? f.decidedAt.getTime() : to
      return measuredAt > f.slaDueAt.getTime()
    })
    return breached.length / ofSeverity.length
  }

  const violationsBySubject = new Map<string, number>()
  for (const f of cases) {
    if (f.outcome === 'violation') violationsBySubject.set(f.subjectId, (violationsBySubject.get(f.subjectId) ?? 0) + 1)
  }
  const repeatOffenderRate = share([...violationsBySubject.values()].filter((n) => n >= 2).length, violationsBySubject.size)

  const resolvedAppeals = cases.flatMap((f) => f.appeals).filter((a) => a.outcome !== null)
  const appealOverturnRate = share(resolvedAppeals.filter((a) => a.outcome === 'overturned').length, resolvedAppeals.length)

  const compared = cases.filter((f) => f.decidedAt !== null && f.llmCategoryId !== null && f.finalCategoryId !== null)
  const llmAcceptanceRate = share(compared.filter((f) => f.llmCategoryId === f.finalCategoryId).length, compared.length)

  return {
    cases: cases.length,
    medianTimeToFirstActionMs: median(cases.flatMap((f) => (f.firstActionAt ? [f.firstActionAt.getTime() - f.openedAt.getTime()] : []))),
    medianTimeToResolutionMs: median(cases.flatMap((f) => (f.resolvedAt ? [f.resolvedAt.getTime() - f.openedAt.getTime()] : []))),
    slaBreachRate: { P0: breachRate('P0'), P1: breachRate('P1'), P2: breachRate('P2') },
    repeatOffenderRate,
    appealOverturnRate,
    llmAcceptanceRate,
  }
}

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole)

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
