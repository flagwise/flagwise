// Violation score ledger with decay. The score is never stored as a number that gets edited; it is
// always computed from the ledger, so replaying the same ledger gives the same score.
//
// Entries are processed by `at`, ties keeping their order in the array:
//   violation   points from an upheld decision (points: positive integer)
//   adjustment  manual change by a moderator (delta: non-zero integer, reason: non-empty)
//   reset       manual reset to 0 (reason: non-empty)
//   reversal    an appeal overturned a decision; `reverses` is the id of that violation
//
// Both functions first validate the whole ledger (not only entries up to `at`) and throw a
// RangeError when: two entries share an id; points or delta break the rules above; a reason is
// empty; a reversal does not point to an earlier violation, or to one already reversed; or a decay
// setting is not made of positive integers.
//
// Decay of one violation at time t, by its severity (age = t - violation.at):
//   none                          always `points`
//   expire after N days           `points` while age < N days, then 0
//   step: X points every N days   max(0, points - floor(age / N days) * X)

export type Severity = 'P0' | 'P1' | 'P2'

export type Decay =
  | { readonly kind: 'none' }
  | { readonly kind: 'expire'; readonly afterDays: number }
  | { readonly kind: 'step'; readonly everyDays: number; readonly points: number }

export interface LedgerConfig {
  readonly decay: Readonly<Record<Severity, Decay>>
}

/** Default decay: none for P0, expiry after 180 days for P1 and 90 days for P2. */
export const DEFAULT_LEDGER_CONFIG: LedgerConfig = {
  decay: {
    P0: { kind: 'none' },
    P1: { kind: 'expire', afterDays: 180 },
    P2: { kind: 'expire', afterDays: 90 },
  },
}

export type LedgerEntry =
  | { readonly type: 'violation'; readonly id: string; readonly at: Date; readonly severity: Severity; readonly points: number }
  | { readonly type: 'adjustment'; readonly id: string; readonly at: Date; readonly delta: number; readonly reason: string }
  | { readonly type: 'reset'; readonly id: string; readonly at: Date; readonly reason: string }
  | { readonly type: 'reversal'; readonly id: string; readonly at: Date; readonly reverses: string }

export interface Score {
  readonly score: number
  readonly live: readonly { readonly id: string; readonly value: number }[]
}

export interface ThresholdEvent {
  readonly type: 'crossed' | 'rearmed'
  readonly threshold: number
  readonly at: Date
  readonly score: number
}

/**
 * The score at `at`, counting entries with `entry.at <= at`.
 *
 * - A reset cancels every violation and adjustment processed before it, for good (a later reversal
 *   of such a violation is allowed and changes nothing).
 * - A violation counts its decayed value, or 0 once its reversal has been processed.
 * - `score = max(0, sum of violation values + sum of adjustments after the last reset)`, so a
 *   negative adjustment carries over: -50 on a score of 30 shows 0, and a later violation of 30
 *   shows 10.
 * - `live` lists the violations after the last reset that are not reversed and still have a value
 *   above 0, as `{ id, value }`, in processing order.
 */
export function scoreAt(entries: readonly LedgerEntry[], at: Date, config: LedgerConfig = DEFAULT_LEDGER_CONFIG): Score {
  const sorted = validateAndSort(entries, config)
  return computeScore(sorted, at.getTime(), config)
}

/**
 * Threshold crossings up to `until`.
 *
 * `thresholds` must be distinct positive integers (else RangeError). The score can only change at
 * an entry's `at` or when a violation decays (its expiry time, or each step time while its value is
 * still above 0). At each such moment `<= until`, in order and without duplicates, the score is
 * computed; every threshold starts armed, and for each threshold ascending:
 *
 * - armed and score >= threshold: `{ type: 'crossed', threshold, at, score }`, then disarmed;
 * - disarmed and score < threshold: `{ type: 'rearmed', threshold, at, score }`, then armed.
 *
 * Events are ordered by time, then by threshold.
 */
export function thresholdEvents(
  entries: readonly LedgerEntry[],
  thresholds: readonly number[],
  until: Date,
  config: LedgerConfig = DEFAULT_LEDGER_CONFIG,
): ThresholdEvent[] {
  const sorted = validateAndSort(entries, config)
  if (new Set(thresholds).size !== thresholds.length || thresholds.some((t) => !isPositiveInt(t))) {
    throw new RangeError('Thresholds must be distinct positive integers')
  }
  const ascending = [...thresholds].sort((a, b) => a - b)
  const limit = until.getTime()

  const moments = new Set<number>()
  for (const e of sorted) {
    moments.add(e.at.getTime())
    if (e.type === 'violation') for (const t of decayMoments(e, config.decay[e.severity], limit)) moments.add(t)
  }

  const armed = new Map(ascending.map((t) => [t, true]))
  const events: ThresholdEvent[] = []
  for (const time of [...moments].filter((m) => m <= limit).sort((a, b) => a - b)) {
    const { score } = computeScore(sorted, time, config)
    for (const threshold of ascending) {
      if (armed.get(threshold) && score >= threshold) {
        events.push({ type: 'crossed', threshold, at: new Date(time), score })
        armed.set(threshold, false)
      } else if (!armed.get(threshold) && score < threshold) {
        events.push({ type: 'rearmed', threshold, at: new Date(time), score })
        armed.set(threshold, true)
      }
    }
  }
  return events
}

const DAY_MS = 86_400_000

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0

function validateAndSort(entries: readonly LedgerEntry[], config: LedgerConfig): LedgerEntry[] {
  for (const severity of ['P0', 'P1', 'P2'] as const) {
    const d = config.decay[severity]
    if (d.kind === 'expire' && !isPositiveInt(d.afterDays)) throw new RangeError('Decay days must be positive integers')
    if (d.kind === 'step' && !(isPositiveInt(d.everyDays) && isPositiveInt(d.points))) {
      throw new RangeError('Decay steps must be positive integers')
    }
  }

  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i).map((x) => x.e)
  const ids = new Set<string>()
  const reversible = new Set<string>()
  for (const e of sorted) {
    if (ids.has(e.id)) throw new RangeError(`Duplicate entry id ${e.id}`)
    ids.add(e.id)
    if (e.type === 'violation') {
      if (!isPositiveInt(e.points)) throw new RangeError('Points must be a positive integer')
      reversible.add(e.id)
    } else if (e.type === 'adjustment') {
      if (!Number.isInteger(e.delta) || e.delta === 0) throw new RangeError('Delta must be a non-zero integer')
      if (e.reason === '') throw new RangeError('Reason must not be empty')
    } else if (e.type === 'reset') {
      if (e.reason === '') throw new RangeError('Reason must not be empty')
    } else {
      if (!reversible.delete(e.reverses)) throw new RangeError(`Reversal ${e.id} has no violation to reverse`)
    }
  }
  return sorted
}

function decayedValue(v: { at: Date; points: number }, decay: Decay, time: number): number {
  const age = time - v.at.getTime()
  switch (decay.kind) {
    case 'none':
      return v.points
    case 'expire':
      return age < decay.afterDays * DAY_MS ? v.points : 0
    case 'step':
      return Math.max(0, v.points - Math.floor(age / (decay.everyDays * DAY_MS)) * decay.points)
  }
}

function computeScore(sorted: readonly LedgerEntry[], time: number, config: LedgerConfig): Score {
  let violations: { id: string; at: Date; severity: Severity; points: number }[] = []
  let adjustments = 0
  const reversed = new Set<string>()
  for (const e of sorted) {
    if (e.at.getTime() > time) break
    if (e.type === 'violation') violations.push(e)
    else if (e.type === 'adjustment') adjustments += e.delta
    else if (e.type === 'reset') {
      violations = []
      adjustments = 0
    } else reversed.add(e.reverses)
  }
  const live: { id: string; value: number }[] = []
  let total = adjustments
  for (const v of violations) {
    if (reversed.has(v.id)) continue
    const value = decayedValue(v, config.decay[v.severity], time)
    if (value > 0) {
      live.push({ id: v.id, value })
      total += value
    }
  }
  return { score: Math.max(0, total), live }
}

function decayMoments(v: { at: Date; points: number }, decay: Decay, limit: number): number[] {
  const start = v.at.getTime()
  if (decay.kind === 'expire') return [start + decay.afterDays * DAY_MS]
  if (decay.kind !== 'step') return []
  const out: number[] = []
  for (let k = 1; v.points - (k - 1) * decay.points > 0; k++) {
    const t = start + k * decay.everyDays * DAY_MS
    if (t > limit) break
    out.push(t)
  }
  return out
}
