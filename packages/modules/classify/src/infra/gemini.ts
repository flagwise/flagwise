// The Gemini provider (Gemini Developer API): one generateContent call per request with a
// JSON-schema answer, and every failure mapped to an LlmFailure.

import { ApiError, FinishReason, GoogleGenAI, HarmBlockThreshold, HarmCategory, type GenerateContentResponse } from '@google/genai'
import { LlmError, type LlmProvider, type LlmUsage } from '../app/ports.ts'

export interface GeminiProviderOptions {
  readonly apiKey: string
  /** For a proxy or gateway; default the Gemini API. */
  readonly baseURL?: string
  /** Per attempt, in milliseconds (default 30 s). */
  readonly timeoutMs?: number
  /** Retries of 408, 429 and 5xx, by the SDK (default 2). */
  readonly maxRetries?: number
  /** For tests. */
  readonly fetch?: typeof fetch
}

/** Reports are about abuse, so content filters would block the very evidence to classify. */
const SAFETY_OFF = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.OFF }))

/** Thrown by the wrapped fetch, so a network failure is told apart from a bug. */
class FetchFailure extends Error {
  readonly timedOut: boolean
  constructor(err: unknown) {
    super(err instanceof Error ? err.message : String(err))
    this.timedOut = err instanceof Error && err.name === 'AbortError'
  }
}

/**
 * Calls generateContent with the system prompt as the system instruction, the input as the only
 * user message, `maxOutputTokens`, a JSON answer following the schema (`responseJsonSchema`) and
 * the harassment, hate, sexual and dangerous-content filters off. The model's default thinking
 * applies; its thinking tokens count as output.
 *
 * Failures, as LlmError: 401 and 403 'auth'; 429 after the SDK's retries 'rate_limited'; 5xx and
 * connection errors 'server'; a timeout 'timeout'; any other 4xx 'bad_request'. A blocked prompt,
 * an answer that did not finish normally (cut off at max tokens, stopped for safety, recitation or
 * any other reason) or text that is not JSON is 'invalid_output', with the call's usage.
 */
export function geminiProvider(options: GeminiProviderOptions): LlmProvider {
  const baseFetch = options.fetch ?? globalThis.fetch
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      ...(options.baseURL ? { baseUrl: options.baseURL } : {}),
      timeout: options.timeoutMs ?? 30_000,
      retryOptions: { attempts: (options.maxRetries ?? 2) + 1 },
      fetch: async (input, init) => {
        try {
          return await baseFetch(input, init)
        } catch (err) {
          throw new FetchFailure(err)
        }
      },
    },
  })

  return {
    async complete(request) {
      let response: GenerateContentResponse
      try {
        response = await client.models.generateContent({
          model: request.model,
          contents: [{ role: 'user', parts: [{ text: request.input }] }],
          config: {
            systemInstruction: request.system,
            maxOutputTokens: request.maxTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: request.schema,
            safetySettings: SAFETY_OFF,
          },
        })
      } catch (err) {
        throw toLlmError(err)
      }

      const meta = response.usageMetadata
      const cached = meta?.cachedContentTokenCount ?? 0
      const usage: LlmUsage = {
        input: (meta?.promptTokenCount ?? 0) - cached,
        output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
        cached,
      }
      if (response.promptFeedback?.blockReason) {
        throw new LlmError({ kind: 'invalid_output' }, `Gemini blocked the prompt (${response.promptFeedback.blockReason})`, usage)
      }
      const finish = response.candidates?.[0]?.finishReason
      if (finish !== FinishReason.STOP) throw new LlmError({ kind: 'invalid_output' }, `The answer did not finish normally (${finish ?? 'no answer'})`, usage)
      let json: unknown
      try {
        json = JSON.parse(response.text ?? '')
      } catch {
        throw new LlmError({ kind: 'invalid_output' }, 'The answer is not JSON', usage)
      }
      return { json, usage, model: response.modelVersion || request.model }
    },
  }
}

function toLlmError(err: unknown): unknown {
  if (err instanceof FetchFailure) {
    return err.timedOut ? new LlmError({ kind: 'timeout' }, 'Gemini API timed out') : new LlmError({ kind: 'server' }, `Gemini API unreachable: ${err.message}`)
  }
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return new LlmError({ kind: 'auth' }, `Gemini API refused the key (${err.status})`)
    if (err.status === 429) return new LlmError({ kind: 'rate_limited' }, 'Gemini API rate limit')
    return err.status >= 500
      ? new LlmError({ kind: 'server' }, `Gemini API error ${err.status}`)
      : new LlmError({ kind: 'bad_request' }, `Gemini API rejected the request (${err.status}): ${err.message}`)
  }
  // Anything else is a bug, not an API failure: it is not hidden behind the rules fallback.
  return err
}
