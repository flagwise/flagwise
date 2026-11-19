import { describe, expect, it } from 'vitest'
import { buildSupportBundle, type SupportInput } from '../src/domain/support-bundle.ts'

const T0 = new Date('2026-11-03T09:00:00.000Z').getTime()
const at = (s: number) => new Date(T0 + s * 1000)
const iso = (s: number) => at(s).toISOString()

const input = (o: Partial<SupportInput> = {}): SupportInput => ({
  flagwiseVersion: '0.4.2',
  caseId: 'case_1',
  appId: 'app_a',
  traceId: 'trace_9f',
  timeline: [
    { at: at(60), type: 'case.triaged', state: 'open' },
    { at: at(0), type: 'report.received', actorName: 'Jane Doe', actorEmail: 'jane@example.com', note: 'he asked for a transfer' },
    { at: at(120), type: 'action.failed', state: 'action_failed' },
  ],
  classification: {
    model: 'claude-haiku-5-5',
    promptVersion: 'p12',
    confidence: 0.71,
    signals: ['off_platform_payment'],
    classifiedBy: 'llm',
    summary: 'Asked Jane Doe for $200',
  },
  triageRules: [{ rule: 'category_severity', inputs: { category: 'scams_fraud', severity: 'P1' } }],
  webhookAttempts: [{ at: at(110), status: 500, latencyMs: 812, url: 'https://appRef.example.com/hooks' }],
  tenantNote: '  Ban did not apply  ',
  evidence: { kind: 'message', content: ['can you send me $200 first?'] },
  ...o,
})

const opts = { includeEvidence: false, joinEvalSet: false }

describe('buildSupportBundle', () => {
  it('builds the bundle without personal data or evidence', () => {
    const { bundle, truncated } = buildSupportBundle(input(), opts)
    expect(truncated).toBe(false)
    expect(bundle).toEqual({
      bundle_version: 1,
      flagwise_version: '0.4.2',
      case_id: 'case_1',
      app_id: 'app_a',
      trace_id: 'trace_9f',
      timeline: [
        { at: iso(0), type: 'report.received' },
        { at: iso(60), type: 'case.triaged', state: 'open' },
        { at: iso(120), type: 'action.failed', state: 'action_failed' },
      ],
      classification: { model: 'claude-haiku-5-5', prompt_version: 'p12', confidence: 0.71, signals: ['off_platform_payment'], classified_by: 'llm' },
      triage_rules: [{ rule: 'category_severity', inputs: { category: 'scams_fraud', severity: 'P1' } }],
      webhook_attempts: [{ at: iso(110), status: 500, latency_ms: 812 }],
      tenant_note: 'Ban did not apply',
      eval_set_opt_in: false,
      truncated_events: 0,
    })
    const json = JSON.stringify(bundle)
    for (const leak of ['Jane', 'jane@example.com', 'transfer', '$200', 'appRef.example.com']) expect(json).not.toContain(leak)
    expect('evidence' in bundle).toBe(false)
  })

  it('keeps the keys in order', () => {
    expect(Object.keys(buildSupportBundle(input(), { includeEvidence: true, joinEvalSet: true }).bundle)).toEqual([
      'bundle_version',
      'flagwise_version',
      'case_id',
      'app_id',
      'trace_id',
      'timeline',
      'classification',
      'triage_rules',
      'webhook_attempts',
      'tenant_note',
      'eval_set_opt_in',
      'evidence',
      'truncated_events',
    ])
  })

  it('includes evidence and the eval opt-in only when asked', () => {
    const { bundle } = buildSupportBundle(input(), { includeEvidence: true, joinEvalSet: true })
    expect(bundle.evidence).toEqual({ kind: 'message', content: ['can you send me $200 first?'] })
    expect(bundle.eval_set_opt_in).toBe(true)
    expect(buildSupportBundle(input({ evidence: undefined }), { includeEvidence: true, joinEvalSet: false }).bundle.evidence).toBeNull()
  })

  it('handles a rules-only case without classification', () => {
    expect(buildSupportBundle(input({ classification: null }), opts).bundle.classification).toBeNull()
  })

  it('keeps the timeline order stable for equal times', () => {
    const timeline = [
      { at: at(5), type: 'b' },
      { at: at(5), type: 'a' },
      { at: at(1), type: 'z' },
    ]
    expect(buildSupportBundle(input({ timeline }), opts).bundle.timeline.map((e) => e.type)).toEqual(['z', 'b', 'a'])
  })

  it('drops the oldest timeline entries to fit the size limit', () => {
    const timeline = Array.from({ length: 50 }, (_, i) => ({ at: at(i), type: `event.${String(i).padStart(2, '0')}` }))
    const full = buildSupportBundle(input({ timeline }), opts).bundle
    const size = (b: unknown) => new TextEncoder().encode(JSON.stringify(b)).length
    const oneEntry = size({ at: iso(0), type: 'event.00' }) + 1
    const limit = size(full) - 3 * oneEntry
    const { bundle, truncated } = buildSupportBundle(input({ timeline }), opts, limit)
    expect(truncated).toBe(true)
    expect(bundle.truncated_events).toBe(3)
    expect(bundle.timeline[0]?.type).toBe('event.03')
    expect(bundle.timeline).toHaveLength(47)
    expect(size(bundle)).toBeLessThanOrEqual(limit)
  })

  it('accepts a bundle exactly at the limit', () => {
    const exact = new TextEncoder().encode(JSON.stringify(buildSupportBundle(input(), opts).bundle)).length
    expect(buildSupportBundle(input(), opts, exact).truncated).toBe(false)
  })

  it('refuses when even an empty timeline is too big', () => {
    expect(() => buildSupportBundle(input({ evidence: 'x'.repeat(5000) }), { includeEvidence: true, joinEvalSet: false }, 2000)).toThrow(RangeError)
  })

  it('limits the appRef note to 2000 characters after trimming', () => {
    expect(buildSupportBundle(input({ tenantNote: ` ${'n'.repeat(2000)} ` }), opts).bundle.tenant_note).toHaveLength(2000)
    expect(() => buildSupportBundle(input({ tenantNote: 'n'.repeat(2001) }), opts)).toThrow(RangeError)
  })
})
