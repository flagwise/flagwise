// The provider for any OpenAI-compatible Chat Completions API (OpenAI, Ollama, vLLM, OpenRouter,
// Groq and the like), chosen by base URL. One call per request, every failure mapped to an
// LlmFailure.

import OpenAI from 'openai'
import { LlmError, type LlmProvider, type LlmUsage } from '../app/ports.ts'

export interface OpenAiCompatibleOptions {
  /** The API root, such as http://localhost:11434/v1 for Ollama. */
  readonly baseURL: string
  /** Servers that need no key (a local Ollama) take any value. */
  readonly apiKey?: string
  /**
   * 'schema' (default) asks for the answer's JSON schema; 'object' asks only for a JSON object, for
   * servers or models without JSON-schema output. Either way the answer is validated by classify.
   */
  readonly jsonMode?: 'schema' | 'object'
  /** Per attempt, in milliseconds (default 60 s; local models can be slow). */
  readonly timeoutMs?: number
  /** Retries of 408, 409, 429, 5xx and connection errors, by the SDK (default 2). */
  readonly maxRetries?: number
  /** For tests. */
  readonly fetch?: typeof fetch
}

/**
 * Sends the system prompt and the input as two chat messages with `max_tokens` and a
 * `response_format` per `jsonMode`. Servers cache the shared prompt prefix on their own, if at all.
 *
 * The answer is the first choice's content, as JSON; one surrounding ```json fence is accepted.
 * Failures, as LlmError: 401 and 403 'auth'; 429 after the SDK's retries 'rate_limited'; 5xx and
 * connection errors 'server'; a timeout 'timeout'; any other 4xx 'bad_request'. A refusal, a
 * cut-off or filtered answer, or content that is not JSON is 'invalid_output', with the call's
 * usage.
 */
export function openAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const client = new OpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey ?? 'unused',
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: options.maxRetries ?? 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const jsonMode = options.jsonMode ?? 'schema'

  return {
    async complete(request) {
      let completion: OpenAI.ChatCompletion
      try {
        completion = await client.chat.completions.create({
          model: request.model,
          max_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.input },
          ],
          response_format:
            jsonMode === 'schema'
              ? { type: 'json_schema', json_schema: { name: 'classification', schema: { ...request.schema }, strict: true } }
              : { type: 'json_object' },
        })
      } catch (err) {
        throw toLlmError(err)
      }

      const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const usage: LlmUsage = {
        input: (completion.usage?.prompt_tokens ?? 0) - cached,
        output: completion.usage?.completion_tokens ?? 0,
        cached,
      }
      const choice = completion.choices[0]
      if (!choice) throw new LlmError({ kind: 'invalid_output' }, 'The answer has no choices', usage)
      if (choice.message.refusal) throw new LlmError({ kind: 'invalid_output' }, 'The model refused to classify', usage)
      if (choice.finish_reason === 'length') throw new LlmError({ kind: 'invalid_output' }, 'The answer was cut off at max_tokens', usage)
      if (choice.finish_reason === 'content_filter') throw new LlmError({ kind: 'invalid_output' }, 'The answer was filtered', usage)
      const text = (choice.message.content ?? '').trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1')
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new LlmError({ kind: 'invalid_output' }, 'The answer is not JSON', usage)
      }
      return { json, usage, model: completion.model || request.model }
    },
  }
}

function toLlmError(err: unknown): unknown {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new LlmError({ kind: 'timeout' }, 'LLM API timed out')
  if (err instanceof OpenAI.APIConnectionError) return new LlmError({ kind: 'server' }, `LLM API unreachable: ${err.message}`)
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError({ kind: 'auth' }, `LLM API refused the key (${err.status})`)
  }
  if (err instanceof OpenAI.RateLimitError) return new LlmError({ kind: 'rate_limited' }, 'LLM API rate limit')
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    return err.status >= 500
      ? new LlmError({ kind: 'server' }, `LLM API error ${err.status}`)
      : new LlmError({ kind: 'bad_request' }, `LLM API rejected the request (${err.status}): ${err.message}`)
  }
  // Anything else is a bug, not an API failure: it is not hidden behind the rules fallback.
  return err
}
