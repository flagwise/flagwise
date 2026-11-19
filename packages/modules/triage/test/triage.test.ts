// Expected numbers worked out by hand.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIAGE_CONFIG,
  P0_SIGNALS,
  triage,
  type CategoryRule,
  type TriageConfig,
  type TriageInput,
} from '../src/domain/triage.ts'

const OPENED = new Date('2026-11-03T09:00:00.000Z')
const OLD = new Date('2025-01-01T00:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(OPENED.getTime() - ms)
const after = (ms: number) => new Date(OPENED.getTime() + ms)

const harassment: CategoryRule = {
  id: 'harassment_bullying',
  severity: 'P1',
  p0Locked: false,
  suggestedActionKeys: ['warn'],
}

type Overrides = {
  category?: Partial<CategoryRule>
  classification?: Partial<TriageInput['classification']>
  reported?: Partial<TriageInput['reported']>
  reporters?: TriageInput['reporters']
}

/** An established P1 harassment case with one established, neutral reporter. */
function input(o: Overrides = {}): TriageInput {
  return {
    openedAt: OPENED,
    category: { ...harassment, ...o.category },
    classification: { signals: [], injectionSuspected: false, preRuleP0: false, ...o.classification },
    reported: { accountCreatedAt: OLD, violationScore: 0, ...o.reported },
    reporters: o.reporters ?? [{ accountCreatedAt: OLD, credibility: null }],
  }
}

const withConfig = (c: Partial<TriageConfig>): TriageConfig => ({ ...DEFAULT_TRIAGE_CONFIG, ...c })

describe('baseline', () => {
  it('triages an ordinary P1 case', () => {
    expect(triage(input())).toEqual({
      severity: 'P1',
      priority: 2020,
      slaDueAt: after(24 * HOUR),
      suggestedActionKeys: ['warn'],
      applied: [],
      flags: [],
    })
  })

  it('triages an ordinary P2 case', () => {
    const r = triage(input({ category: { severity: 'P2' } }))
    expect(r.severity).toBe('P2')
    expect(r.priority).toBe(1020)
    expect(r.slaDueAt).toEqual(after(72 * HOUR))
  })

  it('has the documented defaults', () => {
    expect(DEFAULT_TRIAGE_CONFIG).toEqual({
      slaHours: { P0: 1, P1: 24, P2: 72 },
      points: { P0: 100, P1: 30, P2: 10 },
      reportedNewAccountDays: 7,
      newReporterHours: 24,
      newAccountPointMultiplier: 1.5,
      thresholds: [],
    })
  })
})

describe('severity', () => {
  it.each(P0_SIGNALS)('raises to P0 on the %s signal', (signal) => {
    const r = triage(input({ category: { severity: 'P2' }, classification: { signals: [signal] } }))
    expect(r.severity).toBe('P0')
    expect(r.applied).toEqual(['p0_signal'])
    expect(r.priority).toBe(3020)
    expect(r.slaDueAt).toEqual(after(1 * HOUR))
  })

  it('ignores signals that are not P0 signals', () => {
    const r = triage(input({ classification: { signals: ['off_platform_payment', 'threat'] } }))
    expect(r.severity).toBe('P1')
    expect(r.applied).toEqual([])
  })

  it('keeps a P0-locked category at P0 even when configured lower', () => {
    const r = triage(input({ category: { id: 'custom_underage', severity: 'P2', p0Locked: true } }))
    expect(r.severity).toBe('P0')
    expect(r.applied).toEqual(['p0_category'])
  })

  it('raises to P0 when pre-rules found a P0 signal', () => {
    const r = triage(input({ classification: { preRuleP0: true } }))
    expect(r.severity).toBe('P0')
    expect(r.applied).toEqual(['p0_pre_rule'])
  })

  it('lists every P0 cause, in order', () => {
    const r = triage(
      input({
        category: { severity: 'P0', p0Locked: true },
        classification: { signals: ['credible_threat', 'minor_involved'], preRuleP0: true },
      }),
    )
    expect(r.severity).toBe('P0')
    expect(r.applied).toEqual(['p0_category', 'p0_signal', 'p0_pre_rule'])
  })

  it('never lowers a category configured as P0', () => {
    expect(triage(input({ category: { severity: 'P0' } })).severity).toBe('P0')
  })

  it('does not let a suspected injection change severity or priority', () => {
    const plain = triage(input({ category: { severity: 'P2' } }))
    const injected = triage(input({ category: { severity: 'P2' }, classification: { injectionSuspected: true } }))
    expect(injected.severity).toBe(plain.severity)
    expect(injected.priority).toBe(plain.priority)
    expect(injected.flags).toEqual(['injection_suspected'])
  })
})

describe('reported account', () => {
  it('boosts priority for a new reported account', () => {
    const r = triage(input({ reported: { accountCreatedAt: ago(2 * DAY) } }))
    expect(r.priority).toBe(2120)
    expect(r.applied).toEqual(['reported_new_account'])
  })

  it('treats an account exactly at the threshold as not new', () => {
    expect(triage(input({ reported: { accountCreatedAt: ago(7 * DAY) } })).priority).toBe(2020)
    expect(triage(input({ reported: { accountCreatedAt: ago(7 * DAY - 1) } })).priority).toBe(2120)
  })

  it('uses the configured threshold', () => {
    const r = triage(input({ reported: { accountCreatedAt: ago(2 * DAY) } }), withConfig({ reportedNewAccountDays: 1 }))
    expect(r.priority).toBe(2020)
  })

  it('treats an unknown age as neutral and flags it', () => {
    const r = triage(input({ reported: { accountCreatedAt: undefined } }))
    expect(r.priority).toBe(2020)
    expect(r.applied).toEqual([])
    expect(r.flags).toEqual(['reported_age_unknown'])
  })

  it.each([
    [50, 2070],
    [200, 2220],
    [500, 2220],
    [-10, 2020],
  ])('adds the violation score %i, clamped to 0..200', (score, priority) => {
    expect(triage(input({ reported: { violationScore: score } })).priority).toBe(priority)
  })
})

describe('reporters', () => {
  it('halves a new reporter', () => {
    const r = triage(input({ reporters: [{ accountCreatedAt: ago(9 * HOUR), credibility: null }] }))
    expect(r.priority).toBe(2010)
    expect(r.applied).toEqual(['reporter_new_account'])
  })

  it('treats a reporter exactly at the threshold as not new', () => {
    expect(triage(input({ reporters: [{ accountCreatedAt: ago(24 * HOUR), credibility: null }] })).priority).toBe(2020)
  })

  it('treats a reporter with unknown age as neutral', () => {
    expect(triage(input({ reporters: [{ credibility: null }] })).priority).toBe(2020)
  })

  it.each([
    [0, 2010, ['reporter_low_credibility']],
    [0.2, 2014, ['reporter_low_credibility']],
    [0.5, 2020, []],
    [0.9, 2020, []],
    [1, 2020, []],
  ])('weighs credibility %s, only ever lowering priority', (credibility, priority, applied) => {
    const r = triage(input({ reporters: [{ accountCreatedAt: OLD, credibility }] }))
    expect(r.priority).toBe(priority)
    expect(r.applied).toEqual(applied)
  })

  it('combines new account and low credibility', () => {
    const r = triage(input({ reporters: [{ accountCreatedAt: ago(HOUR), credibility: 0.2 }] }))
    expect(r.priority).toBe(2007)
    expect(r.applied).toEqual(['reporter_new_account', 'reporter_low_credibility'])
  })

  it('never lowers a P0 case for its reporters', () => {
    const r = triage(
      input({
        classification: { signals: ['minor_involved'] },
        reporters: [{ accountCreatedAt: ago(HOUR), credibility: 0 }],
      }),
    )
    expect(r.priority).toBe(3020)
    expect(r.applied).toEqual(['p0_signal'])
  })

  it('adds up several reporters, capped at five', () => {
    const established = { accountCreatedAt: OLD, credibility: null }
    const fresh = { accountCreatedAt: ago(HOUR), credibility: null }
    expect(triage(input({ reporters: [established, established, established] })).priority).toBe(2060)
    expect(triage(input({ reporters: [established, established, fresh] })).priority).toBe(2050)
    expect(triage(input({ reporters: Array(8).fill(established) })).priority).toBe(2100)
    expect(triage(input({ reporters: [] })).priority).toBe(2000)
  })
})

describe('priority bands', () => {
  it('never lets a P2 case outrank a P1 case', () => {
    const fresh = { accountCreatedAt: ago(HOUR), credibility: 0 }
    const best = { accountCreatedAt: OLD, credibility: null }
    const highestP2 = triage(
      input({
        category: { severity: 'P2' },
        reported: { accountCreatedAt: ago(HOUR), violationScore: 1000 },
        reporters: Array(10).fill(best),
      }),
    )
    const lowestP1 = triage(input({ reporters: [fresh] }))
    expect(highestP2.priority).toBe(1400)
    expect(lowestP1.priority).toBe(2005)
    expect(highestP2.priority).toBeLessThan(lowestP1.priority)
  })
})

describe('SLA due time', () => {
  it('uses the category SLA for its own severity', () => {
    expect(triage(input({ category: { slaHours: 12 } })).slaDueAt).toEqual(after(12 * HOUR))
  })

  it('falls back to the app SLA when a signal raised the severity', () => {
    const r = triage(input({ category: { slaHours: 12 }, classification: { signals: ['terrorism'] } }))
    expect(r.slaDueAt).toEqual(after(1 * HOUR))
  })

  it('uses the configured app SLA', () => {
    const r = triage(input(), withConfig({ slaHours: { P0: 2, P1: 8, P2: 48 } }))
    expect(r.slaDueAt).toEqual(after(8 * HOUR))
  })
})

describe('suggested actions', () => {
  const thresholds = [
    { score: 100, actionKey: 'ban' },
    { score: 50, actionKey: 'suspend_7d' },
  ]
  const cfg = withConfig({ thresholds })

  it('suggests the category actions when no threshold is crossed', () => {
    const r = triage(input({ category: { suggestedActionKeys: ['warn', 'hide_content'] } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['warn', 'hide_content'])
    expect(r.applied).toEqual([])
  })

  it('appends the action of a threshold this case would cross', () => {
    // 40 + 30 (P1) = 70 crosses 50
    const r = triage(input({ reported: { violationScore: 40 } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['warn', 'suspend_7d'])
    expect(r.applied).toEqual(['threshold_action'])
  })

  it('does not repeat an action the category already suggests', () => {
    const r = triage(input({ category: { suggestedActionKeys: ['suspend_7d'] }, reported: { violationScore: 40 } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['suspend_7d'])
    expect(r.applied).toEqual(['threshold_action'])
  })

  it('applies the new-account multiplier to the projected points', () => {
    // new account: 60 + round(30 * 1.5) = 105 crosses 100 (50 is already below the score)
    const r = triage(input({ reported: { accountCreatedAt: ago(DAY), violationScore: 60 } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['warn', 'ban'])
    expect(r.applied).toEqual(['reported_new_account', 'threshold_action'])
  })

  it('takes only the highest threshold crossed', () => {
    // 0 + 100 (P0) = 100 crosses 50 and 100
    const r = triage(input({ category: { suggestedActionKeys: [] }, classification: { preRuleP0: true } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['ban'])
  })

  it('ignores a threshold the score has already reached', () => {
    // 50 + 10 (P2) = 60: 50 is not crossed upward again
    const r = triage(input({ category: { severity: 'P2' }, reported: { violationScore: 50 } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['warn'])
    expect(r.applied).toEqual([])
  })

  it('counts a threshold reached exactly', () => {
    // 20 + 30 = 50
    const r = triage(input({ reported: { violationScore: 20 } }), cfg)
    expect(r.suggestedActionKeys).toEqual(['warn', 'suspend_7d'])
  })
})

describe('flags', () => {
  it('flags the Other category', () => {
    expect(triage(input({ category: { id: 'other', severity: 'P2' } })).flags).toEqual(['other_category'])
  })

  it('lists flags in order', () => {
    const r = triage(
      input({
        category: { id: 'other' },
        classification: { injectionSuspected: true },
        reported: { accountCreatedAt: undefined },
      }),
    )
    expect(r.flags).toEqual(['injection_suspected', 'other_category', 'reported_age_unknown'])
  })
})

describe('determinism', () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object' && !(o instanceof Date)) {
      Object.values(o).forEach(deepFreeze)
      Object.freeze(o)
    }
    return o
  }

  it('gives the same result for the same input and does not mutate it', () => {
    const frozen = deepFreeze(
      input({
        classification: { signals: ['minor_involved'] },
        reported: { accountCreatedAt: ago(DAY), violationScore: 20 },
        reporters: [{ accountCreatedAt: ago(HOUR), credibility: 0.1 }],
      }),
    )
    const snapshot = structuredClone(frozen)
    const a = triage(frozen, withConfig({ thresholds: [{ score: 100, actionKey: 'ban' }] }))
    const b = triage(frozen, withConfig({ thresholds: [{ score: 100, actionKey: 'ban' }] }))
    expect(a).toEqual(b)
    expect(frozen).toEqual(snapshot)
  })

  it('does not read the system clock', () => {
    const old = new Date('2001-01-01T00:00:00.000Z')
    const r = triage({
      ...input({ reported: { accountCreatedAt: new Date(old.getTime() - DAY) }, reporters: [{ credibility: null }] }),
      openedAt: old,
    })
    expect(r.slaDueAt).toEqual(new Date(old.getTime() + 24 * HOUR))
    expect(r.applied).toEqual(['reported_new_account'])
  })
})
