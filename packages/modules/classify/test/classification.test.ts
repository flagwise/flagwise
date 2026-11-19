import { describe, expect, it } from 'vitest'
import {
  P0_SIGNALS,
  escalation,
  nextClassifyRetry,
  validateClassification,
} from '../src/domain/classification.ts'

const good = () => ({
  category_id: 'scams_fraud.romance_scam',
  custom_category_id: null,
  confidence: 0.82,
  signals: ['off_platform_payment'],
  summary: 'Asked the reporter to transfer $200 for a plane ticket.',
  injection_suspected: false,
})

describe('validateClassification', () => {
  it('accepts valid output and converts it', () => {
    expect(validateClassification({ ...good(), extra: 'ignored' })).toEqual({
      ok: true,
      value: {
        categoryId: 'scams_fraud.romance_scam',
        customCategoryId: null,
        confidence: 0.82,
        signals: ['off_platform_payment'],
        summary: 'Asked the reporter to transfer $200 for a plane ticket.',
        injectionSuspected: false,
      },
    })
  })

  it('treats a missing custom category as null and keeps a given one', () => {
    const { custom_category_id: _drop, ...rest } = good()
    expect(validateClassification(rest)).toMatchObject({ ok: true, value: { customCategoryId: null } })
    expect(validateClassification({ ...good(), custom_category_id: 'cat_marketplace_fake' })).toMatchObject({
      ok: true,
      value: { customCategoryId: 'cat_marketplace_fake' },
    })
  })

  it('accepts the edges', () => {
    expect(validateClassification({ ...good(), confidence: 0, signals: [], summary: '' }).ok).toBe(true)
    expect(validateClassification({ ...good(), confidence: 1, summary: 's'.repeat(400), signals: Array(20).fill('x') }).ok).toBe(true)
    expect(validateClassification({ ...good(), category_id: 'c'.repeat(128) }).ok).toBe(true)
  })

  it.each<[string, Record<string, unknown>, string[]]>([
    ['empty category', { category_id: '' }, ['category_id']],
    ['long category', { category_id: 'c'.repeat(129) }, ['category_id']],
    ['numeric category', { category_id: 12 }, ['category_id']],
    ['empty custom category', { custom_category_id: '' }, ['custom_category_id']],
    ['confidence above 1', { confidence: 1.01 }, ['confidence']],
    ['negative confidence', { confidence: -0.1 }, ['confidence']],
    ['confidence as a string', { confidence: '0.8' }, ['confidence']],
    ['NaN confidence', { confidence: Number.NaN }, ['confidence']],
    ['too many signals', { signals: Array(21).fill('x') }, ['signals']],
    ['an empty signal', { signals: ['ok', ''] }, ['signals']],
    ['signals not an array', { signals: 'minor_involved' }, ['signals']],
    ['long summary', { summary: 's'.repeat(401) }, ['summary']],
    ['injection flag as a string', { injection_suspected: 'false' }, ['injection_suspected']],
    ['several problems', { summary: null, confidence: 2, category_id: undefined }, ['category_id', 'confidence', 'summary']],
  ])('rejects %s', (_label, patch, invalid) => {
    expect(validateClassification({ ...good(), ...patch })).toEqual({ ok: false, invalid })
  })

  it.each([null, 'text', [good()], 42])('rejects a non-object %j with every field', (raw) => {
    expect(validateClassification(raw)).toEqual({
      ok: false,
      invalid: ['category_id', 'custom_category_id', 'confidence', 'signals', 'summary', 'injection_suspected'],
    })
  })
})

describe('escalation', () => {
  const base = { confidence: 0.9, signals: [] as string[], monthCases: 100, monthEscalations: 0 }

  it('does not escalate a confident result without P0 signals', () => {
    expect(escalation(base)).toEqual({ escalate: false, reason: null, capped: false })
    expect(escalation({ ...base, confidence: 0.6 })).toEqual({ escalate: false, reason: null, capped: false })
  })

  it('escalates below 0.6 confidence', () => {
    expect(escalation({ ...base, confidence: 0.59 })).toEqual({ escalate: true, reason: 'low_confidence', capped: false })
  })

  it.each(P0_SIGNALS)('escalates on the %s signal, which wins over low confidence', (signal) => {
    expect(escalation({ ...base, confidence: 0.2, signals: ['spam', signal] })).toEqual({ escalate: true, reason: 'p0_signal', capped: false })
  })

  it('stops at 15% of the month, rounded up', () => {
    const low = { ...base, confidence: 0.1 }
    expect(escalation({ ...low, monthCases: 100, monthEscalations: 14 }).escalate).toBe(true)
    expect(escalation({ ...low, monthCases: 100, monthEscalations: 15 })).toEqual({ escalate: false, reason: 'low_confidence', capped: true })
    expect(escalation({ ...low, monthCases: 1, monthEscalations: 0 }).escalate).toBe(true)
    expect(escalation({ ...low, monthCases: 7, monthEscalations: 1 }).escalate).toBe(true)
    expect(escalation({ ...low, monthCases: 7, monthEscalations: 2 }).capped).toBe(true)
    expect(escalation({ ...base, signals: ['terrorism'], monthCases: 10, monthEscalations: 2 })).toEqual({ escalate: false, reason: 'p0_signal', capped: true })
  })

  it('uses a custom cap', () => {
    expect(escalation({ ...base, confidence: 0.1, monthCases: 10, monthEscalations: 4, capPercent: 50 }).escalate).toBe(true)
    expect(escalation({ ...base, confidence: 0.1, monthCases: 10, monthEscalations: 5, capPercent: 50 }).capped).toBe(true)
  })

  it('reports no cap when nothing was wanted, even over the cap', () => {
    expect(escalation({ ...base, monthEscalations: 99 })).toEqual({ escalate: false, reason: null, capped: false })
  })

  it('uses whole numbers: a 7% cap allows exactly 7 of 100, although (7 / 100) * 100 is 7.000000000000001', () => {
    expect(escalation({ ...base, confidence: 0.1, monthCases: 100, monthEscalations: 6, capPercent: 7 }).escalate).toBe(true)
    expect(escalation({ ...base, confidence: 0.1, monthCases: 100, monthEscalations: 7, capPercent: 7 }).capped).toBe(true)
    expect(escalation({ ...base, confidence: 0.1, monthCases: 50, monthEscalations: 7, capPercent: 14 }).capped).toBe(true)
    expect(escalation({ ...base, confidence: 0.1, monthCases: 100, monthEscalations: 15 }).capped).toBe(true)
    expect(escalation({ ...base, confidence: 0.1, monthCases: 20, monthEscalations: 2 }).escalate).toBe(true)
    expect(escalation({ ...base, confidence: 0.1, monthCases: 20, monthEscalations: 3 }).capped).toBe(true)
  })

  it.each([
    { monthCases: 0, monthEscalations: 0 },
    { monthCases: 1.5, monthEscalations: 0 },
    { monthCases: 10, monthEscalations: -1 },
    { monthCases: 10, monthEscalations: 0, capPercent: 0 },
    { monthCases: 10, monthEscalations: 0, capPercent: 101 },
    { monthCases: 10, monthEscalations: 0, capPercent: 12.5 },
  ])('rejects counts %o', (counts) => {
    expect(() => escalation({ ...base, ...counts })).toThrow(RangeError)
  })
})

describe('nextClassifyRetry', () => {
  const F = new Date('2026-11-03T09:00:00.000Z').getTime()
  const MIN = 60_000
  const at = (ms: number) => new Date(F + ms)

  it('returns the next 15-minute slot after now', () => {
    expect(nextClassifyRetry(at(0), at(0))).toEqual(at(15 * MIN))
    expect(nextClassifyRetry(at(0), at(15 * MIN - 1))).toEqual(at(15 * MIN))
    expect(nextClassifyRetry(at(0), at(15 * MIN))).toEqual(at(30 * MIN))
    expect(nextClassifyRetry(at(0), at(100 * MIN))).toEqual(at(105 * MIN))
  })

  it('stops after 6 hours', () => {
    expect(nextClassifyRetry(at(0), at(360 * MIN - 1))).toEqual(at(360 * MIN))
    expect(nextClassifyRetry(at(0), at(360 * MIN))).toBeNull()
    expect(nextClassifyRetry(at(0), at(1000 * MIN))).toBeNull()
  })

  it('handles a clock before the failure', () => {
    expect(nextClassifyRetry(at(0), at(-MIN))).toEqual(at(15 * MIN))
  })
})
