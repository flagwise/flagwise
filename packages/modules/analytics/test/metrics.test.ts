// Expected values worked out by hand.
import { describe, expect, it } from 'vitest'
import { computeMetrics, type CaseFacts } from '../src/domain/metrics.ts'

const T0 = new Date('2026-11-01T00:00:00.000Z').getTime()
const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H
const at = (ms: number) => new Date(T0 + ms)
const NOV = { from: at(0), to: at(30 * DAY) }

let n = 0
const fact = (o: Partial<CaseFacts> = {}): CaseFacts => ({
  caseId: `case_${++n}`,
  livemode: true,
  severity: 'P1',
  subjectId: `u_${n}`,
  openedAt: at(DAY),
  slaDueAt: at(2 * DAY),
  firstActionAt: null,
  decidedAt: null,
  resolvedAt: null,
  outcome: null,
  llmCategoryId: null,
  finalCategoryId: null,
  appeals: [],
  ...o,
})

const empty = {
  cases: 0,
  medianTimeToFirstActionMs: null,
  medianTimeToResolutionMs: null,
  slaBreachRate: { P0: null, P1: null, P2: null },
  repeatOffenderRate: null,
  appealOverturnRate: null,
  llmAcceptanceRate: null,
}

describe('computeMetrics', () => {
  it('returns nulls for an empty period', () => {
    expect(computeMetrics([], NOV)).toEqual(empty)
  })

  it('counts only live cases opened in the period, end exclusive', () => {
    const facts = [
      fact({ openedAt: at(0) }),
      fact({ openedAt: at(30 * DAY - 1) }),
      fact({ openedAt: at(30 * DAY) }),
      fact({ openedAt: at(-1) }),
      fact({ livemode: false }),
    ]
    expect(computeMetrics(facts, NOV).cases).toBe(2)
  })

  it('takes medians of first action and resolution times', () => {
    const facts = [
      fact({ firstActionAt: at(DAY + 10 * MIN), resolvedAt: at(DAY + 2 * H) }),
      fact({ firstActionAt: at(DAY + 30 * MIN), resolvedAt: at(DAY + 4 * H) }),
      fact({ firstActionAt: at(DAY + 20 * MIN) }),
      fact(),
    ]
    const m = computeMetrics(facts, NOV)
    expect(m.medianTimeToFirstActionMs).toBe(20 * MIN)
    expect(m.medianTimeToResolutionMs).toBe(3 * H)
  })

  it('measures SLA breaches as of the end of the period', () => {
    const due = at(2 * DAY)
    const facts = [
      fact({ severity: 'P1', decidedAt: at(DAY + H) }),
      fact({ severity: 'P1', decidedAt: at(3 * DAY) }),
      fact({ severity: 'P1' }),
      fact({ severity: 'P1', openedAt: at(29 * DAY), slaDueAt: at(31 * DAY) }),
      fact({ severity: 'P0', slaDueAt: at(DAY + H), decidedAt: at(DAY + H) }),
      fact({ severity: 'P2', slaDueAt: due, decidedAt: at(40 * DAY) }),
    ]
    expect(computeMetrics(facts, NOV).slaBreachRate).toEqual({ P0: 0, P1: 0.5, P2: 1 })
  })

  it('does not count a case decided after the period as decided in time', () => {
    const f = fact({ openedAt: at(29 * DAY), slaDueAt: at(29 * DAY + H), decidedAt: at(31 * DAY) })
    expect(computeMetrics([f], NOV).slaBreachRate.P1).toBe(1)
    expect(computeMetrics([f], { from: at(0), to: at(29 * DAY + H) }).slaBreachRate.P1).toBe(0)
  })

  it('finds repeat offenders among subjects with violations', () => {
    const facts = [
      fact({ subjectId: 'u_a', outcome: 'violation' }),
      fact({ subjectId: 'u_a', outcome: 'violation' }),
      fact({ subjectId: 'u_b', outcome: 'violation' }),
      fact({ subjectId: 'u_b', outcome: 'no_violation' }),
      fact({ subjectId: 'u_c', outcome: 'violation' }),
      fact({ subjectId: 'u_d', outcome: 'no_violation' }),
      fact({ subjectId: 'u_e', outcome: 'violation', openedAt: at(-DAY) }),
      fact({ subjectId: 'u_c', outcome: 'violation', livemode: false }),
    ]
    expect(computeMetrics(facts, NOV).repeatOffenderRate).toBeCloseTo(1 / 3, 12)
  })

  it('computes the appeal overturn rate over resolved appeals', () => {
    const facts = [
      fact({ appeals: [{ filedAt: at(2 * DAY), outcome: 'overturned' }, { filedAt: at(2 * DAY), outcome: 'upheld' }] }),
      fact({ appeals: [{ filedAt: at(3 * DAY), outcome: 'upheld' }, { filedAt: at(3 * DAY), outcome: null }] }),
      fact({ appeals: [{ filedAt: at(3 * DAY), outcome: 'overturned' }], openedAt: at(-DAY) }),
    ]
    expect(computeMetrics(facts, NOV).appealOverturnRate).toBeCloseTo(1 / 3, 12)
    expect(computeMetrics([fact({ appeals: [{ filedAt: at(2 * DAY), outcome: null }] })], NOV).appealOverturnRate).toBeNull()
  })

  it('measures how often moderators keep the LLM category', () => {
    const facts = [
      fact({ decidedAt: at(2 * DAY), llmCategoryId: 'spam', finalCategoryId: 'spam' }),
      fact({ decidedAt: at(2 * DAY), llmCategoryId: 'spam', finalCategoryId: 'spam' }),
      fact({ decidedAt: at(2 * DAY), llmCategoryId: 'spam', finalCategoryId: 'scams_fraud' }),
      fact({ decidedAt: at(2 * DAY), llmCategoryId: 'spam', finalCategoryId: 'spam' }),
      fact({ decidedAt: at(2 * DAY), llmCategoryId: null, finalCategoryId: 'spam' }),
      fact({ decidedAt: null, llmCategoryId: 'spam', finalCategoryId: 'other' }),
    ]
    expect(computeMetrics(facts, NOV).llmAcceptanceRate).toBe(0.75)
  })

  it('rejects an empty or reversed period', () => {
    expect(() => computeMetrics([], { from: at(0), to: at(0) })).toThrow(RangeError)
    expect(() => computeMetrics([], { from: at(DAY), to: at(0) })).toThrow(RangeError)
  })

  it('combines everything for a small month', () => {
    const facts = [
      fact({ severity: 'P0', slaDueAt: at(DAY + H), firstActionAt: at(DAY + 5 * MIN), decidedAt: at(DAY + 30 * MIN), resolvedAt: at(DAY + 40 * MIN), outcome: 'violation', subjectId: 'u_x', llmCategoryId: 'child_safety', finalCategoryId: 'child_safety' }),
      fact({ severity: 'P2', slaDueAt: at(4 * DAY), firstActionAt: at(DAY + 15 * MIN), decidedAt: at(5 * DAY), resolvedAt: at(5 * DAY), outcome: 'no_violation', llmCategoryId: 'spam', finalCategoryId: 'other' }),
    ]
    expect(computeMetrics(facts, NOV)).toEqual({
      cases: 2,
      medianTimeToFirstActionMs: 10 * MIN,
      medianTimeToResolutionMs: (40 * MIN + 4 * DAY) / 2,
      slaBreachRate: { P0: 0, P1: null, P2: 1 },
      repeatOffenderRate: 0,
      appealOverturnRate: null,
      llmAcceptanceRate: 0.5,
    })
  })
})
