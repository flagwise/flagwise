// Expected dates worked out by hand.
import { describe, expect, it } from 'vitest'
import { DEFAULT_RETENTION_POLICY, planPurge, type LegalHolds, type RetentionPolicy, type StoredItem } from '../src/domain/retention.ts'

const T0 = new Date('2025-01-01T00:00:00.000Z').getTime()
const DAY = 86_400_000
const d = (days: number, extraMs = 0) => new Date(T0 + days * DAY + extraMs)
const NO_HOLDS: LegalHolds = { caseIds: [], subjectIds: [] }
const P = DEFAULT_RETENTION_POLICY

const item = (o: Partial<StoredItem> & Pick<StoredItem, 'id' | 'kind'>): StoredItem => ({ livemode: true, createdAt: d(0), ...o })
const plan = (items: StoredItem[], now: number, policy: RetentionPolicy = P, holds = NO_HOLDS) => planPurge(items, policy, holds, d(now))

describe('defaults', () => {
  it('match the default retention', () => {
    expect(DEFAULT_RETENTION_POLICY).toEqual({
      evidenceDaysAfterClose: 365,
      noticeDays: 730,
      appealDays: 730,
      auditDays: 730,
      testDataDays: 30,
      maxDays: null,
    })
  })
})

describe('due times', () => {
  it('keeps evidence for a year after its case closed', () => {
    const ev = item({ id: 'ev', kind: 'evidence', caseClosedAt: d(10) })
    expect(plan([ev], 374)).toMatchObject({ purge: [], kept: [{ id: 'ev', reason: 'not_due', dueAt: d(375) }], nextDueAt: d(375) })
    expect(plan([ev], 375).purge).toEqual(['ev'])
  })

  it('never purges evidence of an open case', () => {
    for (const caseClosedAt of [undefined, null]) {
      const ev = item({ id: 'ev', kind: 'evidence', caseClosedAt })
      expect(plan([ev], 10_000)).toEqual({
        purge: [],
        kept: [{ id: 'ev', reason: 'case_open', dueAt: null }],
        nextDueAt: null,
        auditCheckpoint: { live: null, test: null },
      })
    }
  })

  it.each([
    ['notice', 730],
    ['appeal', 730],
    ['audit', 730],
  ] as const)('keeps a %s for %i days from creation', (kind, days) => {
    const x = item({ id: 'x', kind, createdAt: d(5), seq: 1 })
    expect(plan([x], 5 + days, P).purge).toEqual(['x'])
    expect(plan([x], 5 + days, P, NO_HOLDS).kept).toEqual([])
    expect(planPurge([x], P, NO_HOLDS, d(5 + days, -1)).kept).toEqual([{ id: 'x', reason: 'not_due', dueAt: d(5 + days) }])
  })

  it('uses the policy for each kind', () => {
    const policy = { ...P, noticeDays: 10, appealDays: 20, auditDays: 30, evidenceDaysAfterClose: 40 }
    const items = [
      item({ id: 'n', kind: 'notice' }),
      item({ id: 'a', kind: 'appeal' }),
      item({ id: 'u', kind: 'audit', seq: 1 }),
      item({ id: 'e', kind: 'evidence', caseClosedAt: d(0) }),
    ]
    expect(plan(items, 25, policy)).toEqual({
      purge: ['n', 'a'],
      kept: [
        { id: 'u', reason: 'not_due', dueAt: d(30) },
        { id: 'e', reason: 'not_due', dueAt: d(40) },
      ],
      nextDueAt: d(30),
      auditCheckpoint: { live: null, test: null },
    })
  })

  it('caps live data at the plan maximum', () => {
    const free = { ...P, maxDays: 365 }
    const items = [item({ id: 'n', kind: 'notice' }), item({ id: 'e', kind: 'evidence', caseClosedAt: d(0) })]
    expect(plan(items, 365, free).purge).toEqual(['n', 'e'])
    expect(plan(items, 364, free).kept.map((k) => k.dueAt)).toEqual([d(365), d(365)])
    expect(plan([item({ id: 'n', kind: 'notice' })], 20, { ...P, noticeDays: 20, maxDays: 365 }).purge).toEqual(['n'])
  })

  it('purges test data after 30 days, whatever the kind or case state', () => {
    const items = [
      item({ id: 'ev', kind: 'evidence', livemode: false, caseClosedAt: null }),
      item({ id: 'n', kind: 'notice', livemode: false }),
      item({ id: 'u', kind: 'audit', livemode: false, seq: 1 }),
    ]
    expect(plan(items, 29).kept.map((k) => [k.id, k.reason, k.dueAt])).toEqual([
      ['ev', 'not_due', d(30)],
      ['n', 'not_due', d(30)],
      ['u', 'not_due', d(30)],
    ])
    expect(plan(items, 30)).toMatchObject({ purge: ['ev', 'n', 'u'], auditCheckpoint: { live: null, test: 1 } })
  })

  it('does not cap test data at the plan maximum', () => {
    const t = item({ id: 't', kind: 'notice', livemode: false })
    expect(plan([t], 15, { ...P, testDataDays: 60, maxDays: 10 }).kept).toEqual([{ id: 't', reason: 'not_due', dueAt: d(60) }])
  })
})

describe('legal hold', () => {
  const holds = { caseIds: ['case_p0'], subjectIds: ['u_9'] }

  it('keeps items of a held case or subject, even when due or open', () => {
    const items = [
      item({ id: 'a', kind: 'notice', caseId: 'case_p0' }),
      item({ id: 'b', kind: 'notice', subjectId: 'u_9' }),
      item({ id: 'c', kind: 'evidence', caseId: 'case_p0', caseClosedAt: null }),
      item({ id: 'd', kind: 'notice', caseId: 'case_other', subjectId: 'u_1' }),
    ]
    expect(plan(items, 1_000, P, holds)).toEqual({
      purge: ['d'],
      kept: [
        { id: 'a', reason: 'legal_hold', dueAt: d(730) },
        { id: 'b', reason: 'legal_hold', dueAt: d(730) },
        { id: 'c', reason: 'legal_hold', dueAt: null },
      ],
      nextDueAt: null,
      auditCheckpoint: { live: null, test: null },
    })
  })

  it('applies to test data too', () => {
    expect(plan([item({ id: 't', kind: 'notice', livemode: false, caseId: 'case_p0' })], 100, P, holds).purge).toEqual([])
  })
})

describe('audit chain order', () => {
  const audit = (seq: number, createdDay: number, o: Partial<StoredItem> = {}) =>
    item({ id: `a${seq}`, kind: 'audit', seq, createdAt: d(createdDay), ...o })

  it('purges a prefix and reports the checkpoint', () => {
    const items = [audit(3, 20), audit(1, 0), audit(2, 10), audit(4, 30)]
    expect(plan(items, 745)).toEqual({
      purge: ['a1', 'a2'],
      kept: [
        { id: 'a3', reason: 'not_due', dueAt: d(750) },
        { id: 'a4', reason: 'not_due', dueAt: d(760) },
      ],
      nextDueAt: d(750),
      auditCheckpoint: { live: 2, test: null },
    })
  })

  it('stops at a held entry and keeps everything after it in order', () => {
    const items = [audit(1, 0), audit(2, 1, { caseId: 'case_p0' }), audit(3, 2), audit(4, 3)]
    expect(plan(items, 2_000, P, { caseIds: ['case_p0'], subjectIds: [] })).toEqual({
      purge: ['a1'],
      kept: [
        { id: 'a2', reason: 'legal_hold', dueAt: d(731) },
        { id: 'a3', reason: 'audit_order', dueAt: d(732) },
        { id: 'a4', reason: 'audit_order', dueAt: d(733) },
      ],
      nextDueAt: null,
      auditCheckpoint: { live: 1, test: null },
    })
  })

  it('keeps later entries when an earlier one is not due yet', () => {
    const policy = { ...P, auditDays: 100 }
    const items = [audit(1, 50), audit(2, 0)]
    expect(plan(items, 120, policy).kept).toEqual([
      { id: 'a1', reason: 'not_due', dueAt: d(150) },
      { id: 'a2', reason: 'audit_order', dueAt: d(100) },
    ])
  })

  it('treats the live and test chains separately', () => {
    const items = [
      audit(1, 0, { livemode: false, caseId: 'case_p0' }),
      audit(2, 0, { livemode: false, id: 't2' }),
      audit(1, 0, { id: 'l1' }),
      audit(2, 0, { id: 'l2' }),
    ]
    expect(plan(items, 800, P, { caseIds: ['case_p0'], subjectIds: [] })).toMatchObject({
      purge: ['l1', 'l2'],
      kept: [
        { id: 'a1', reason: 'legal_hold' },
        { id: 't2', reason: 'audit_order' },
      ],
      auditCheckpoint: { live: 2, test: null },
    })
  })

  it('does not affect other kinds', () => {
    const items = [audit(1, 0, { caseId: 'case_p0' }), item({ id: 'n', kind: 'notice' })]
    expect(plan(items, 800, P, { caseIds: ['case_p0'], subjectIds: [] }).purge).toEqual(['n'])
  })
})

describe('validation', () => {
  it.each<Partial<RetentionPolicy>>([{ noticeDays: 0 }, { auditDays: 1.5 }, { testDataDays: -1 }, { maxDays: 0 }, { evidenceDaysAfterClose: Number.NaN }])(
    'rejects policy %o',
    (patch) => {
      expect(() => plan([], 0, { ...P, ...patch })).toThrow(RangeError)
    },
  )

  it('rejects duplicate ids and bad audit sequence numbers', () => {
    expect(() => plan([item({ id: 'x', kind: 'notice' }), item({ id: 'x', kind: 'appeal' })], 0)).toThrow(RangeError)
    expect(() => plan([item({ id: 'u', kind: 'audit' })], 0)).toThrow(RangeError)
    expect(() => plan([item({ id: 'u', kind: 'audit', seq: 0 })], 0)).toThrow(RangeError)
    expect(() => plan([item({ id: 'u', kind: 'audit', seq: 1 }), item({ id: 'v', kind: 'audit', seq: 1 })], 0)).toThrow(RangeError)
  })

  it('allows the same seq in the live and test chains', () => {
    const items = [item({ id: 'u', kind: 'audit', seq: 1 }), item({ id: 'v', kind: 'audit', seq: 1, livemode: false })]
    expect(() => plan(items, 0)).not.toThrow()
  })

  it('returns an empty plan for no items', () => {
    expect(plan([], 0)).toEqual({ purge: [], kept: [], nextDueAt: null, auditCheckpoint: { live: null, test: null } })
  })
})
