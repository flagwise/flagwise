// The OpenAI-compatible provider against a fake fetch: the request it sends and how it reads answers and failures.
import { describe, expect, it } from 'vitest'
import { CLASSIFICATION_SCHEMA, LlmError, openAiCompatibleProvider, type OpenAiCompatibleOptions } from '../src/index.ts'

const request = { model: 'llama3.3', system: 'You classify reports.', input: '<report_data>{}</report_data>', schema: CLASSIFICATION_SCHEMA, maxTokens: 4000 }

const completion = (message: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1_793_000_000,
  model: 'llama3.3:70b',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"category_id":"other"}', refusal: null, ...message } }],
  usage: { prompt_tokens: 2050, completion_tokens: 30, total_tokens: 2080, prompt_tokens_details: { cached_tokens: 2000 } },
  ...over,
})

function provider(status: number, body: unknown, options: Partial<OpenAiCompatibleOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { llm: openAiCompatibleProvider({ baseURL: 'http://ollama.local:11434/v1', maxRetries: 0, fetch, ...options }), calls }
}

const failureOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof LlmError ? { failure: e.failure, usage: e.usage } : e),
  )

describe('openAiCompatibleProvider', () => {
  it('sends the prompt as chat messages with a JSON-schema answer, and reads the answer', async () => {
    const { llm, calls } = provider(200, completion())
    expect(await llm.complete(request)).toEqual({ json: { category_id: 'other' }, usage: { input: 50, output: 30, cached: 2000 }, model: 'llama3.3:70b' })
    expect(calls[0]!.url).toBe('http://ollama.local:11434/v1/chat/completions')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'llama3.3',
      max_tokens: 4000,
      messages: [
        { role: 'system', content: 'You classify reports.' },
        { role: 'user', content: '<report_data>{}</report_data>' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'classification', schema: JSON.parse(JSON.stringify(CLASSIFICATION_SCHEMA)), strict: true } },
    })
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer unused')
  })

  it('asks only for a JSON object in object mode, and accepts a fenced answer', async () => {
    const { llm, calls } = provider(200, completion({ content: '```json\n{"category_id":"other"}\n```' }), { jsonMode: 'object', apiKey: 'sk-test' })
    expect((await llm.complete(request)).json).toEqual({ category_id: 'other' })
    expect(JSON.parse(String(calls[0]!.init.body)).response_format).toEqual({ type: 'json_object' })
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer sk-test')
  })

  it('counts no tokens when the server reports no usage, and falls back to the asked model', async () => {
    const { llm } = provider(200, completion({}, { usage: undefined, model: '' }))
    expect(await llm.complete(request)).toMatchObject({ usage: { input: 0, output: 0, cached: 0 }, model: 'llama3.3' })
  })

  it.each([
    [401, { kind: 'auth' }],
    [403, { kind: 'auth' }],
    [429, { kind: 'rate_limited' }],
    [500, { kind: 'server' }],
    [503, { kind: 'server' }],
    [400, { kind: 'bad_request' }],
    [404, { kind: 'bad_request' }],
  ])('maps HTTP %i to %o', async (status, failure) => {
    const { llm } = provider(status, { error: { message: 'nope', type: 'some_error' } })
    expect(await failureOf(llm.complete(request))).toEqual({ failure, usage: undefined })
  })

  it('treats a refusal, a cut-off or filtered answer, no choice and non-JSON text as invalid output, with their usage', async () => {
    const usage = { input: 50, output: 30, cached: 2000 }
    const bodies = [
      completion({ content: null, refusal: 'I cannot help with that.' }),
      completion({}, { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"category', refusal: null } }] }),
      completion({}, { choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: '', refusal: null } }] }),
      completion({}, { choices: [] }),
      completion({ content: 'Sure! Here it is' }),
    ]
    for (const body of bodies) {
      const { llm } = provider(200, body)
      expect(await failureOf(llm.complete(request))).toEqual({ failure: { kind: 'invalid_output' }, usage })
    }
  })

  it('maps an unreachable server to a server failure', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const llm = openAiCompatibleProvider({ baseURL: 'http://ollama.local:11434/v1', maxRetries: 0, fetch })
    expect(await failureOf(llm.complete(request))).toEqual({ failure: { kind: 'server' }, usage: undefined })
  })
})
