// A fake LLM for local development and tests: no network and no key. It answers from the report's
// own text, the same way every time, so a flow can be tried end to end without a provider.

import { LlmError, type LlmProvider, type LlmRequest } from '../app/ports.ts'

/** The default model names the fake reports; any names work. */
export const FAKE_MODELS = { model: 'fake-small', escalationModel: 'fake-strong' } as const

/** Keywords to a global category and the signals they bring, first match wins. */
const RULES: readonly { readonly words: RegExp; readonly categoryId: string; readonly signals: readonly string[] }[] = [
  { words: /\b(kill myself|end my life|suicide)\b/i, categoryId: 'self_harm.suicidal_intent', signals: ['self_harm_intent'] },
  { words: /\b(kill you|hurt you|where you live)\b/i, categoryId: 'threats_violence.threat', signals: ['credible_threat'] },
  { words: /\b(i am 1[0-5]|i'm 1[0-5]|years old and in school)\b/i, categoryId: 'child_safety.underage_user', signals: ['minor_involved'] },
  { words: /\b(crypto|coin|invest(ment)?|trading)\b/i, categoryId: 'scams_fraud.investment_scam', signals: ['asks_for_money'] },
  { words: /(\$\d|\b(money|wire|gift card|bank transfer)\b)/i, categoryId: 'scams_fraud.romance_scam', signals: ['asks_for_money'] },
  { words: /\b(password|verify your account|login code)\b/i, categoryId: 'scams_fraud.phishing', signals: [] },
  { words: /\b(nudes?|sexy)\b/i, categoryId: 'sexual_content.unwanted_advances', signals: [] },
  { words: /\b(idiot|loser|stupid|ugly)\b/i, categoryId: 'harassment.bullying', signals: [] },
  { words: /\b(buy now|follow me|promo code|discount)\b/i, categoryId: 'spam.spam', signals: [] },
]

/** Tags a report's text can carry to steer the fake: `[fake:<what>]` or `[fake:<what>=<value>]`. */
const TAG = /\[fake:([a-z_]+)(?:=([A-Za-z0-9_.,]+))?\]/g

/**
 * A provider that classifies without a model. It reads the report data in `request.input` (the
 * JSON in `<report_data>`) and answers:
 * - category_id: the first keyword rule that matches the reporter's text or the messages, else
 *   `other`; confidence 0.9 on a match, 0.7 otherwise; signals from the rule.
 * - summary: how many messages it read, in English.
 * - usage: about a token per 4 characters in and out, none cached; model: the one asked for.
 *
 * Tags in any text override it: `[fake:category=<id>]` answers that category, `[fake:signals=<a>,<b>]`
 * adds signals (not `signal=`: redaction takes that for a Signal username), `[fake:low]` answers confidence 0.4 (the stronger model is asked
 * again), `[fake:injection]` flags an injection, `[fake:invalid]` answers out of schema, and
 * `[fake:fail]` throws an LlmError (kind server), so the rules fallback runs.
 */
export function fakeProvider(): LlmProvider {
  return {
    async complete(request: LlmRequest) {
      const text = textOf(request.input)
      const tags = [...text.matchAll(TAG)].map((m) => ({ what: m[1]!, value: m[2] }))
      const has = (what: string) => tags.some((t) => t.what === what)
      const input = Math.ceil((request.system.length + request.input.length) / 4)
      if (has('fail')) throw new LlmError({ kind: 'server' }, 'The fake LLM was told to fail', { input, output: 0, cached: 0 })

      const rule = RULES.find((r) => r.words.test(text))
      const forced = tags.find((t) => t.what === 'category')?.value
      const answer = has('invalid')
        ? { category_id: '', confidence: 2 }
        : {
            category_id: forced ?? rule?.categoryId ?? 'other',
            custom_category_id: null,
            confidence: has('low') ? 0.4 : rule || forced ? 0.9 : 0.7,
            signals: [...new Set([...(rule?.signals ?? []), ...tags.flatMap((t) => (t.what === 'signals' && t.value ? t.value.split(',').filter(Boolean) : []))])],
            summary: `Fake classification of ${messagesIn(request.input)} message(s).`,
            injection_suspected: has('injection'),
          }
      return { json: answer, usage: { input, output: Math.ceil(JSON.stringify(answer).length / 4), cached: 0 }, model: request.model }
    },
  }
}

/** The report data block of the input, parsed; null when it has none or it is not JSON. */
function dataOf(input: string): Record<string, unknown> | null {
  const m = /<report_data>\n?([\s\S]*?)\n?<\/report_data>/.exec(input)
  if (!m) return null
  try {
    const data = JSON.parse(m[1]!) as unknown
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The reporter's text and every message's text, one per line. */
function textOf(input: string): string {
  const data = dataOf(input)
  if (!data) return ''
  const messages = Array.isArray(data['messages']) ? (data['messages'] as { text?: unknown }[]) : []
  return [data['reporter_text'], ...messages.map((m) => m.text)].filter((t): t is string => typeof t === 'string').join('\n')
}

function messagesIn(input: string): number {
  const messages = dataOf(input)?.['messages']
  return Array.isArray(messages) ? messages.length : 0
}
