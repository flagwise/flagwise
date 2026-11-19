// The Anthropic LLM provider: one Messages API call per request with a JSON-schema structured
// output, the system prompt cached, and every failure mapped to an LlmFailure.

import Anthropic from '@anthropic-ai/sdk'
import { LlmError, type LlmProvider, type LlmUsage } from '../app/ports.ts'

export interface AnthropicProviderOptions {
  readonly apiKey: string
  /** For a proxy or gateway; default the Anthropic API. */
  readonly baseURL?: string
  /** Per attempt, in milliseconds (default 30 s). */
  readonly timeoutMs?: number
  /** Retries of 408, 409, 429, 5xx and connection errors, by the SDK (default 2). */
  readonly maxRetries?: number
  /** For tests. */
  readonly fetch?: typeof fetch
}

/** Default models: Haiku class for every case, Sonnet class for escalation. */
export const ANTHROPIC_MODELS = { model: 'claude-haiku-5-5', escalationModel: 'claude-sonnet-5-5' } as const

/**
 * Calls the Messages API with the system prompt as one cached block, the input as the only user
 * message, low effort and `output_config.format` set to the schema.
 *
 * Failures, as LlmError: 401 and 403 'auth'; 429 after the SDK's retries 'rate_limited'; 5xx, 529 and connection errors 'server'; a timeout 'timeout'; any other 4xx
 * 'bad_request'. A refusal, a cut-off answer (max_tokens) or text that is not JSON is
 * 'invalid_output', with the call's usage.
 */
export function anthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    timeout: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async complete(request) {
      let message: Anthropic.Message
      try {
        message = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: request.input }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: { ...request.schema } } },
        })
      } catch (err) {
        throw toLlmError(err)
      }

      const usage: LlmUsage = {
        input: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0),
        output: message.usage.output_tokens,
        cached: message.usage.cache_read_input_tokens ?? 0,
      }
      if (message.stop_reason === 'refusal') throw new LlmError({ kind: 'invalid_output' }, 'The model refused to classify', usage)
      if (message.stop_reason === 'max_tokens') throw new LlmError({ kind: 'invalid_output' }, 'The answer was cut off at max_tokens', usage)
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new LlmError({ kind: 'invalid_output' }, 'The answer is not JSON', usage)
      }
      return { json, usage, model: message.model }
    },
  }
}

function toLlmError(err: unknown): unknown {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError({ kind: 'timeout' }, 'Anthropic API timed out')
  if (err instanceof Anthropic.APIConnectionError) return new LlmError({ kind: 'server' }, `Anthropic API unreachable: ${err.message}`)
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError({ kind: 'auth' }, `Anthropic API refused the key (${err.status})`)
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError({ kind: 'rate_limited' }, 'Anthropic API rate limit')
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return err.status >= 500
      ? new LlmError({ kind: 'server' }, `Anthropic API error ${err.status}`)
      : new LlmError({ kind: 'bad_request' }, `Anthropic API rejected the request (${err.status}): ${err.message}`)
  }
  // Anything else is a bug, not an API failure: it is not hidden behind a fallback.
  return err
}
