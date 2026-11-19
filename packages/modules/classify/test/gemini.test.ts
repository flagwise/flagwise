// The Gemini provider against a fake fetch: the request it sends and how it reads answers and failures.
import { describe, expect, it } from 'vitest'
import { CLASSIFICATION_SCHEMA, geminiProvider, LlmError } from '../src/index.ts'

const request = { model: 'gemini-flash', system: 'You classify reports.', input: '<report_data>{}</report_data>', schema: CLASSIFICATION_SCHEMA, maxTokens: 4000 }

const answer = (over: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: '{"category_id":"other"}' }] }, finishReason: 'STOP', index: 0, ...candidate }],
  usageMetadata: { promptTokenCount: 2050, candidatesTokenCount: 30, thoughtsTokenCount: 120, cachedContentTokenCount: 2000, totalTokenCount: 2200 },
  modelVersion: 'gemini-flash-001',
  ...over,
})

function provider(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { llm: geminiProvider({ apiKey: 'gm-test', maxRetries: 0, fetch }), calls }
}

const failureOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof LlmError ? { failure: e.failure, usage: e.usage } : e),
  )

describe('geminiProvider', () => {
  it('sends a system instruction, a JSON-schema answer and no content filters, and reads the answer', async () => {
    const { llm, calls } = provider(200, answer())
    expect(await llm.complete(request)).toEqual({ json: { category_id: 'other' }, usage: { input: 50, output: 150, cached: 2000 }, model: 'gemini-flash-001' })
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:generateContent')
    expect(new Headers(calls[0]!.init.headers).get('x-goog-api-key')).toBe('gm-test')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: '<report_data>{}</report_data>' }] }],
      systemInstruction: { parts: [{ text: 'You classify reports.' }] },
      generationConfig: { maxOutputTokens: 4000, responseMimeType: 'application/json', responseJsonSchema: JSON.parse(JSON.stringify(CLASSIFICATION_SCHEMA)) },
    })
    expect(body.safetySettings).toEqual(
      ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map((category) => ({ category, threshold: 'OFF' })),
    )
  })

  it('counts no tokens when the API reports no usage, and falls back to the asked model', async () => {
    const { llm } = provider(200, answer({ usageMetadata: undefined, modelVersion: undefined }))
    expect(await llm.complete(request)).toMatchObject({ usage: { input: 0, output: 0, cached: 0 }, model: 'gemini-flash' })
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
    const { llm } = provider(status, { error: { code: status, message: 'nope', status: 'SOME_ERROR' } })
    expect(await failureOf(llm.complete(request))).toEqual({ failure, usage: undefined })
  })

  it('treats a blocked prompt, an answer that did not finish and non-JSON text as invalid output, with their usage', async () => {
    const usage = { input: 50, output: 150, cached: 2000 }
    const bodies = [
      answer({ candidates: undefined, promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
      answer({}, { finishReason: 'MAX_TOKENS' }),
      answer({}, { finishReason: 'SAFETY', content: undefined }),
      answer({}, { finishReason: 'RECITATION' }),
      answer({ candidates: [] }),
      answer({}, { content: { role: 'model', parts: [{ text: 'Sure! Here it is' }] } }),
    ]
    for (const body of bodies) {
      const { llm } = provider(200, body)
      expect(await failureOf(llm.complete(request))).toEqual({ failure: { kind: 'invalid_output' }, usage })
    }
  })

  it('maps an unreachable API to a server failure and an aborted call to a timeout', async () => {
    const failing = (err: Error) =>
      geminiProvider({
        apiKey: 'gm-test',
        maxRetries: 0,
        fetch: (async () => {
          throw err
        }) as unknown as typeof globalThis.fetch,
      })
    expect(await failureOf(failing(new TypeError('fetch failed')).complete(request))).toEqual({ failure: { kind: 'server' }, usage: undefined })
    expect(await failureOf(failing(new DOMException('This operation was aborted', 'AbortError')).complete(request))).toEqual({ failure: { kind: 'timeout' }, usage: undefined })
  })

  it('times out a slow call', async () => {
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError'))))) as unknown as typeof globalThis.fetch
    const llm = geminiProvider({ apiKey: 'gm-test', maxRetries: 0, timeoutMs: 20, fetch })
    expect(await failureOf(llm.complete(request))).toEqual({ failure: { kind: 'timeout' }, usage: undefined })
  })
})
