// The Anthropic provider against a fake fetch: the request it sends and how it reads answers and failures.
import { describe, expect, it } from 'vitest'
import { anthropicProvider, CLASSIFICATION_SCHEMA, LlmError } from '../src/index.ts'

const request = { model: 'claude-haiku-5-5', system: 'You classify reports.', input: '<report_data>{}</report_data>', schema: CLASSIFICATION_SCHEMA, maxTokens: 4000 }

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: '{"category_id":"other"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 2000 },
  ...over,
})

function provider(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } })
  }) as unknown as typeof globalThis.fetch
  return { llm: anthropicProvider({ apiKey: 'sk-test', maxRetries: 0, fetch }), calls }
}

const failureOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof LlmError ? { failure: e.failure, usage: e.usage } : e),
  )

describe('anthropicProvider', () => {
  it('sends a cached system prompt and a JSON-schema output, and reads the answer', async () => {
    const { llm, calls } = provider(200, message())
    expect(await llm.complete(request)).toEqual({ json: { category_id: 'other' }, usage: { input: 60, output: 30, cached: 2000 }, model: 'claude-haiku-5-5' })
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 4000,
      system: [{ type: 'text', text: 'You classify reports.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: '<report_data>{}</report_data>' }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JSON.parse(JSON.stringify(CLASSIFICATION_SCHEMA)) } },
    })
  })

  it.each([
    [401, { kind: 'auth' }],
    [403, { kind: 'auth' }],
    [429, { kind: 'rate_limited' }],
    [500, { kind: 'server' }],
    [529, { kind: 'server' }],
    [400, { kind: 'bad_request' }],
    [404, { kind: 'bad_request' }],
  ])('maps HTTP %i to %o', async (status, failure) => {
    const { llm } = provider(status, { type: 'error', error: { type: 'some_error', message: 'nope' } })
    expect(await failureOf(llm.complete(request))).toEqual({ failure, usage: undefined })
  })

  it('treats a refusal, a cut-off answer and non-JSON text as invalid output, with their usage', async () => {
    const usage = { input: 60, output: 30, cached: 2000 }
    for (const over of [{ stop_reason: 'refusal' }, { stop_reason: 'max_tokens' }, { content: [{ type: 'text', text: 'Sure! Here it is' }] }]) {
      const { llm } = provider(200, message(over))
      expect(await failureOf(llm.complete(request))).toEqual({ failure: { kind: 'invalid_output' }, usage })
    }
  })

  it('maps an unreachable API to a server failure', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const llm = anthropicProvider({ apiKey: 'sk-test', maxRetries: 0, fetch })
    expect(await failureOf(llm.complete(request))).toEqual({ failure: { kind: 'server' }, usage: undefined })
  })
})
