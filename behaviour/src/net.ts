// The outside world of an install, over HTTP: an OpenAI-compatible LLM and the tenant's webhook
// receiver. The server reaches both through the fetch it is given, so the scenarios fake nothing
// inside Flagwise.

export const LLM_BASE_URL = 'http://llm.behaviour.test/v1'
export const WEBHOOK_URL = 'https://hooks.behaviour.test/flagwise'

/** The LLM's answer to one classify call, or 'down' for a provider that refuses every call. */
export type LlmAnswer =
  | 'down'
  | {
      readonly category_id: string
      readonly confidence?: number
      readonly signals?: readonly string[]
      readonly summary?: string
      readonly injection_suspected?: boolean
    }

export interface Webhook {
  readonly type: string
  readonly data: Record<string, any>
}

export interface FakeNet {
  readonly fetch: typeof fetch
  /** How the LLM answers, given the classify input text; replaceable by a scenario. */
  llm: (input: string) => LlmAnswer
  /** LLM calls so far. */
  readonly llmCalls: () => number
  /** Webhooks received so far, in order. */
  readonly webhooks: () => readonly Webhook[]
}

/** Answers like a provider whose key is refused: a 401, which the SDK does not retry. */
const refused = () => new Response(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }), { status: 401, headers: { 'content-type': 'application/json' } })

export function fakeNet(): FakeNet {
  let calls = 0
  const received: Webhook[] = []
  const net: FakeNet = {
    llm: () => 'down',
    llmCalls: () => calls,
    webhooks: () => [...received],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const body = String(init?.body ?? (input instanceof Request ? await input.text() : ''))
      if (url.startsWith(LLM_BASE_URL)) {
        calls++
        const request = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] }
        const answer = net.llm(request.messages.find((m) => m.role === 'user')?.content ?? '')
        if (answer === 'down') return refused()
        const content = JSON.stringify({
          category_id: answer.category_id,
          custom_category_id: null,
          confidence: answer.confidence ?? 0.9,
          signals: answer.signals ?? [],
          summary: answer.summary ?? 'The reported account broke the rules.',
          injection_suspected: answer.injection_suspected ?? false,
        })
        const completion = {
          id: `chatcmpl_${calls}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', logprobs: null }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }
        return new Response(JSON.stringify(completion), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === WEBHOOK_URL) {
        const parsed = JSON.parse(body) as Webhook
        received.push({ type: parsed.type, data: parsed.data })
        return new Response('ok', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch,
  }
  return net
}
