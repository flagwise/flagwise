import { describe, expect, it } from 'vitest'
import { GLOBAL_CATEGORIES, globalCategory, OTHER_CATEGORY_ID, parseReportSnapshot, REPORT_SNAPSHOT_FORMAT } from '../src/index.ts'

describe('the global taxonomy', () => {
  it('has unique group.subcategory ids, plus other', () => {
    const ids = GLOBAL_CATEGORIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of GLOBAL_CATEGORIES.filter((c) => c.id !== OTHER_CATEGORY_ID)) {
      expect(c.id).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(c.id.startsWith(`${c.group}.`)).toBe(true)
    }
    expect(new Set(GLOBAL_CATEGORIES.map((c) => c.group)).size).toBe(20)
  })

  it('keeps the P0 groups at P0, except graphic violence and selling sexual services', () => {
    const notP0 = GLOBAL_CATEGORIES.filter((c) => ['child_safety', 'terrorism', 'threats_violence', 'self_harm', 'sexual_exploitation'].includes(c.group) && c.severity !== 'P0')
    expect(notP0.map((c) => c.id)).toEqual(['threats_violence.graphic_violence', 'sexual_exploitation.selling_sexual_services'])
  })

  it('finds a category by id', () => {
    expect(globalCategory('scams_fraud.romance_scam')).toEqual({ id: 'scams_fraud.romance_scam', group: 'scams_fraud', label: 'Romance scam or asking for money', severity: 'P1' })
    expect(globalCategory('scams_fraud')).toBeUndefined()
  })
})

describe('parseReportSnapshot', () => {
  const blob = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const snapshot = {
    format: REPORT_SNAPSHOT_FORMAT,
    report_id: 'rpt_1',
    received_at: '2026-11-06T09:00:00.000Z',
    report: {
      reporter: { externalId: 'u_jane_doe' },
      reported: { externalId: 'u_john_doe' },
      category: 'spam',
      evidence: { kind: 'message', content: [{ text: 'buy now' }], media: [], metadata: {} },
      identifiers: {},
    },
  }

  it('reads a snapshot', () => {
    expect(parseReportSnapshot(blob(snapshot))).toEqual(snapshot)
  })

  it('refuses other formats, broken JSON and missing parts', () => {
    expect(() => parseReportSnapshot(new TextEncoder().encode('{'))).toThrow('Report snapshot is not JSON')
    expect(() => parseReportSnapshot(blob(null))).toThrow('Report snapshot is not an object')
    expect(() => parseReportSnapshot(blob({ ...snapshot, format: 'flagwise.report.v0' }))).toThrow('Unknown report snapshot format: flagwise.report.v0')
    const broken = { ...snapshot, report: { ...snapshot.report, evidence: { ...snapshot.report.evidence, content: [{ text: 7 }] } } }
    expect(() => parseReportSnapshot(blob(broken))).toThrow('Report snapshot is missing required fields')
  })
})
