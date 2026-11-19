// The fake LLM: what it answers for a report's text and its tags, through the real prompt input.
import { globalCategory, REPORT_SNAPSHOT_FORMAT, type ReportSnapshot } from '@flagwise/contracts'
import { describe, expect, it } from 'vitest'
import { buildInput, CLASSIFICATION_SCHEMA, fakeProvider, LlmError, validateClassification } from '../src/index.ts'

const snapshot = (texts: string[], text?: string): ReportSnapshot => ({
  format: REPORT_SNAPSHOT_FORMAT,
  report_id: 'rpt_1',
  received_at: '2026-11-19T09:00:00.000Z',
  report: {
    reporter: { externalId: 'u_jane_doe' },
    reported: { externalId: 'u_john_doe' },
    category: 'asking_for_money',
    ...(text !== undefined && { text }),
    evidence: { kind: 'message', content: texts.map((t) => ({ text: t, author: 'u_john_doe' })), media: [], metadata: {} },
    identifiers: {},
  },
})
const ask = (texts: string[], text?: string) =>
  fakeProvider().complete({
    model: 'fake-small',
    system: 'You classify user reports.',
    input: buildInput(snapshot(texts, text), { redact: true, summaryLanguage: 'en' }),
    schema: CLASSIFICATION_SCHEMA,
    maxTokens: 1000,
  })

describe('fakeProvider', () => {
  it('answers a valid classification from keywords, the same every time', async () => {
    const first = await ask(['send $200 to my account'])
    expect(first).toEqual(await ask(['send $200 to my account']))
    expect(first).toMatchObject({ model: 'fake-small', usage: { cached: 0 } })
    expect(first.usage.input).toBeGreaterThan(0)
    const v = validateClassification(first.json)
    expect(v).toEqual({
      ok: true,
      value: { categoryId: 'scams_fraud.romance_scam', customCategoryId: null, confidence: 0.9, signals: ['asks_for_money'], summary: 'Fake classification of 1 message(s).', injectionSuspected: false },
    })
  })

  it('reads the reporter text too, gives P0 signals, and answers other when nothing matches', async () => {
    expect((await ask(['hello'], 'He said he will kill you')).json).toMatchObject({ category_id: 'threats_violence.threat', signals: ['credible_threat'] })
    expect((await ask(['hello there'])).json).toMatchObject({ category_id: 'other', confidence: 0.7, signals: [] })
  })

  it('answers only global categories', async () => {
    const texts = ['kill myself', 'kill you', "i'm 13", 'buy crypto', 'wire money', 'your password', 'send nudes', 'you idiot', 'buy now', 'hi']
    for (const t of texts) {
      const id = ((await ask([t])).json as { category_id: string }).category_id
      expect(globalCategory(id), `${t} -> ${id}`).toBeDefined()
    }
  })

  it('follows the tags in the text', async () => {
    expect((await ask(['hi [fake:category=spam.spam] [fake:signals=minor_involved,x] [fake:low] [fake:injection]'])).json).toMatchObject({
      category_id: 'spam.spam',
      confidence: 0.4,
      signals: ['minor_involved', 'x'],
      injection_suspected: true,
    })
    expect(validateClassification((await ask(['[fake:invalid]'])).json)).toMatchObject({ ok: false })
    await expect(ask(['[fake:fail]'])).rejects.toBeInstanceOf(LlmError)
    await expect(ask(['[fake:fail]'])).rejects.toMatchObject({ failure: { kind: 'server' } })
  })
})
