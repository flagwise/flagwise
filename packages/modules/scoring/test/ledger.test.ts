// Expected scores worked out by hand.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEDGER_CONFIG,
  scoreAt,
  thresholdEvents,
  type LedgerConfig,
  type LedgerEntry,
  type Severity,
} from '../src/domain/ledger.ts'

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime()
const DAY = 86_400_000
const d = (days: number, extraMs = 0) => new Date(T0 + days * DAY + extraMs)

let n = 0
const id = () => `e${++n}`
const violation = (days: number, severity: Severity, points: number, entryId = id()): LedgerEntry => ({
  type: 'violation',
  id: entryId,
  at: d(days),
  severity,
  points,
})
const adjustment = (days: number, delta: number): LedgerEntry => ({ type: 'adjustment', id: id(), at: d(days), delta, reason: 'manual' })
const reset = (days: number): LedgerEntry => ({ type: 'reset', id: id(), at: d(days), reason: 'fresh start' })
const reversal = (days: number, reverses: string): LedgerEntry => ({ type: 'reversal', id: id(), at: d(days), reverses })

const score = (entries: LedgerEntry[], days: number, config?: LedgerConfig, extraMs = 0) =>
  scoreAt(entries, d(days, extraMs), config).score

const stepP1: LedgerConfig = { decay: { ...DEFAULT_LEDGER_CONFIG.decay, P1: { kind: 'step', everyDays: 30, points: 10 } } }

describe('defaults', () => {
  it('match the default decay', () => {
    expect(DEFAULT_LEDGER_CONFIG).toEqual({
      decay: { P0: { kind: 'none' }, P1: { kind: 'expire', afterDays: 180 }, P2: { kind: 'expire', afterDays: 90 } },
    })
  })
})

describe('scoreAt: decay', () => {
  it('expires a P1 violation after 180 days', () => {
    const l = [violation(0, 'P1', 30)]
    expect(score(l, 0)).toBe(30)
    expect(score(l, 180, undefined, -1)).toBe(30)
    expect(score(l, 180)).toBe(0)
  })

  it('expires a P2 violation after 90 days', () => {
    const l = [violation(0, 'P2', 10)]
    expect(score(l, 89)).toBe(10)
    expect(score(l, 90)).toBe(0)
  })

  it('never decays a P0 violation', () => {
    expect(score([violation(0, 'P0', 100)], 5_000)).toBe(100)
  })

  it('steps a value down and stops at 0', () => {
    const l = [violation(0, 'P1', 30)]
    expect([0, 29, 30, 59, 60, 90, 400].map((x) => score(l, x, stepP1))).toEqual([30, 30, 20, 20, 10, 0, 0])
  })

  it('decays each violation on its own clock', () => {
    const l = [violation(0, 'P1', 30), violation(100, 'P1', 30), violation(150, 'P2', 10)]
    expect(score(l, 160)).toBe(70)
    expect(score(l, 180)).toBe(40)
    expect(score(l, 240)).toBe(30)
    expect(score(l, 280)).toBe(0)
  })

  it('ignores entries after the evaluation time', () => {
    expect(score([violation(10, 'P0', 100)], 9)).toBe(0)
  })
})

describe('scoreAt: adjustments, resets, reversals', () => {
  it('adds and subtracts manual adjustments, which do not decay', () => {
    const l = [violation(0, 'P1', 30), adjustment(1, 15), adjustment(2, -5)]
    expect(score(l, 2)).toBe(40)
    expect(score(l, 500)).toBe(10)
  })

  it('clamps the shown score at 0 but carries the debt', () => {
    const l = [violation(0, 'P1', 30), adjustment(1, -50)]
    expect(score(l, 1)).toBe(0)
    l.push(violation(2, 'P1', 30))
    expect(score(l, 2)).toBe(10)
  })

  it('cancels everything before a reset', () => {
    const l = [violation(0, 'P1', 30), adjustment(1, 5), reset(2), violation(3, 'P2', 10)]
    expect(score(l, 1)).toBe(35)
    expect(score(l, 2)).toBe(0)
    expect(score(l, 3)).toBe(10)
  })

  it('cancels debt too', () => {
    const l = [adjustment(0, -100), reset(1), violation(2, 'P2', 10)]
    expect(score(l, 2)).toBe(10)
  })

  it('removes a reversed violation from the reversal on', () => {
    const v = violation(0, 'P1', 30)
    const l = [v, violation(1, 'P2', 10), reversal(5, v.id)]
    expect(score(l, 4)).toBe(40)
    expect(score(l, 5)).toBe(10)
  })

  it('allows reversing a violation from before a reset, with no effect', () => {
    const v = violation(0, 'P1', 30)
    const l = [v, reset(1), violation(2, 'P1', 30), reversal(3, v.id)]
    expect(score(l, 3)).toBe(30)
  })

  it('keeps array order for entries at the same time', () => {
    expect(score([violation(0, 'P1', 30), reset(0)], 0)).toBe(0)
    expect(score([reset(0), violation(0, 'P1', 30)], 0)).toBe(30)
  })

  it('sorts by time first, whatever the array order', () => {
    const v = violation(0, 'P1', 30)
    expect(score([reset(5), v], 5)).toBe(0)
  })
})

describe('scoreAt: live', () => {
  it('lists counted violations with their value, in order', () => {
    const a = violation(0, 'P1', 30, 'a')
    const b = violation(10, 'P2', 10, 'b')
    const c = violation(20, 'P0', 100, 'c')
    const e = violation(30, 'P2', 10, 'e')
    const l = [c, a, b, e, reversal(40, 'e')]
    expect(scoreAt(l, d(100)).live).toEqual([
      { id: 'a', value: 30 },
      { id: 'c', value: 100 },
    ])
    expect(scoreAt(l, d(30)).live).toEqual([
      { id: 'a', value: 30 },
      { id: 'b', value: 10 },
      { id: 'c', value: 100 },
      { id: 'e', value: 10 },
    ])
  })

  it('shows stepped values and leaves out violations before a reset', () => {
    const l = [violation(0, 'P1', 30, 'old'), reset(1), violation(2, 'P1', 30, 'new')]
    expect(scoreAt(l, d(32), stepP1).live).toEqual([{ id: 'new', value: 20 }])
  })
})

describe('validation', () => {
  const at = d(0)
  it.each<[string, LedgerEntry[]]>([
    ['duplicate ids', [violation(0, 'P1', 30, 'x'), violation(1, 'P1', 30, 'x')]],
    ['zero points', [violation(0, 'P1', 0)]],
    ['fractional points', [violation(0, 'P1', 2.5)]],
    ['zero delta', [adjustment(0, 0)]],
    ['fractional delta', [adjustment(0, 1.5)]],
    ['empty adjustment reason', [{ type: 'adjustment', id: 'a', at, delta: 5, reason: '' }]],
    ['empty reset reason', [{ type: 'reset', id: 'r', at, reason: '' }]],
    ['reversal of an unknown id', [reversal(0, 'ghost')]],
    ['reversal of a later violation', [reversal(0, 'v'), violation(1, 'P1', 30, 'v')]],
    ['reversal of a non-violation', [adjustment(0, 5), reversal(1, `e${n}`)]],
    ['double reversal', [violation(0, 'P1', 30, 'v2'), reversal(1, 'v2'), reversal(2, 'v2')]],
  ])('rejects %s', (_label, entries) => {
    expect(() => scoreAt(entries, d(10))).toThrow(RangeError)
    expect(() => thresholdEvents(entries, [10], d(10))).toThrow(RangeError)
  })

  it('checks entries after the evaluation time too', () => {
    expect(() => scoreAt([violation(0, 'P1', 30), violation(50, 'P1', -3)], d(1))).toThrow(RangeError)
  })

  it.each<Partial<LedgerConfig['decay']>>([
    { P1: { kind: 'expire', afterDays: 0 } },
    { P2: { kind: 'step', everyDays: 30, points: 0 } },
    { P2: { kind: 'step', everyDays: 1.5, points: 5 } },
  ])('rejects decay %o', (decay) => {
    expect(() => scoreAt([], d(0), { decay: { ...DEFAULT_LEDGER_CONFIG.decay, ...decay } })).toThrow(RangeError)
  })

  it('accepts an empty ledger', () => {
    expect(scoreAt([], d(0))).toEqual({ score: 0, live: [] })
  })
})

describe('thresholdEvents', () => {
  it('fires once per threshold on the way up', () => {
    const l = [violation(0, 'P1', 30), violation(10, 'P1', 30), violation(20, 'P0', 100)]
    expect(thresholdEvents(l, [100, 50], d(400))).toEqual([
      { type: 'crossed', threshold: 50, at: d(10), score: 60 },
      { type: 'crossed', threshold: 100, at: d(20), score: 160 },
    ])
  })

  it('re-arms when decay drops the score below a threshold, and fires again', () => {
    const l = [violation(0, 'P1', 30), violation(10, 'P1', 30), violation(185, 'P1', 30)]
    expect(thresholdEvents(l, [50], d(400))).toEqual([
      { type: 'crossed', threshold: 50, at: d(10), score: 60 },
      { type: 'rearmed', threshold: 50, at: d(180), score: 30 },
      { type: 'crossed', threshold: 50, at: d(185), score: 60 },
      { type: 'rearmed', threshold: 50, at: d(190), score: 30 },
    ])
  })

  it('notices step decay between entries', () => {
    expect(thresholdEvents([violation(0, 'P1', 30)], [25], d(100), stepP1)).toEqual([
      { type: 'crossed', threshold: 25, at: d(0), score: 30 },
      { type: 'rearmed', threshold: 25, at: d(30), score: 20 },
    ])
  })

  it('orders several thresholds at the same moment ascending', () => {
    expect(thresholdEvents([violation(0, 'P1', 30)], [30, 10, 20], d(365))).toEqual([
      { type: 'crossed', threshold: 10, at: d(0), score: 30 },
      { type: 'crossed', threshold: 20, at: d(0), score: 30 },
      { type: 'crossed', threshold: 30, at: d(0), score: 30 },
      { type: 'rearmed', threshold: 10, at: d(180), score: 0 },
      { type: 'rearmed', threshold: 20, at: d(180), score: 0 },
      { type: 'rearmed', threshold: 30, at: d(180), score: 0 },
    ])
  })

  it('includes a moment exactly at until and nothing after it', () => {
    const l = [violation(0, 'P1', 30)]
    expect(thresholdEvents(l, [30], d(180)).map((e) => e.type)).toEqual(['crossed', 'rearmed'])
    expect(thresholdEvents(l, [30], d(180, -1)).map((e) => e.type)).toEqual(['crossed'])
  })

  it('re-arms on a reversal and crosses on an adjustment', () => {
    const v = violation(0, 'P1', 30)
    expect(thresholdEvents([v, reversal(5, v.id), adjustment(6, 40)], [30], d(10))).toEqual([
      { type: 'crossed', threshold: 30, at: d(0), score: 30 },
      { type: 'rearmed', threshold: 30, at: d(5), score: 0 },
      { type: 'crossed', threshold: 30, at: d(6), score: 40 },
    ])
  })

  it('evaluates all entries at one instant together', () => {
    const l = [violation(0, 'P1', 30), reset(0)]
    expect(thresholdEvents(l, [30], d(10))).toEqual([])
  })

  it('returns nothing for an empty ledger', () => {
    expect(thresholdEvents([], [10], d(10))).toEqual([])
  })

  it.each([[[0]], [[10, 10]], [[-5]], [[2.5]]])('rejects thresholds %j', (thresholds) => {
    expect(() => thresholdEvents([], thresholds, d(10))).toThrow(RangeError)
  })
})
