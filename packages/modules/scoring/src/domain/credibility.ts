// Reporter credibility: how often a reporter's reports are upheld.

export interface ReporterHistory {
  readonly upheld: number
  readonly rejected: number
}

/**
 * `upheld / (upheld + rejected)`, a number from 0 to 1, or null (neutral) while fewer than
 * `minDecided` reports are decided.
 *
 * `upheld` counts decided reports where a violation was found (including those later upheld on
 * appeal); `rejected` those decided as no violation. Throws a RangeError when a count or
 * `minDecided` is negative or not an integer.
 */
export function reporterCredibility(history: ReporterHistory, minDecided = 5): number | null {
  for (const n of [history.upheld, history.rejected, minDecided]) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError('Counts must be non-negative integers')
  }
  const decided = history.upheld + history.rejected
  if (decided === 0 || decided < minDecided) return null
  return history.upheld / decided
}
