// Posting a webhook over HTTP with fetch: no redirects followed, a hard timeout, and the response
// body discarded (only its status counts).

import type { PostResult } from '../app/send-webhooks.ts'

/**
 * Posts with `fetch` (default the global one). A redirect is not followed and counts as its 3xx
 * status. When no response arrives within `timeoutMs`, or the connection fails, the result has
 * status null and the reason ('timeout', or the error's message and its cause's code).
 */
export function fetchPost(fetchFn: typeof fetch = fetch, userAgent = 'Flagwise-Webhooks/1'): (url: string, request: { headers: Readonly<Record<string, string>>; body: string }, timeoutMs: number) => Promise<PostResult> {
  return async (url, request, timeoutMs) => {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { ...request.headers, 'user-agent': userAgent },
        body: request.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      await res.body?.cancel().catch(() => {})
      return { status: res.status }
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } }
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { status: null, error: 'timeout' }
      return { status: null, error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message }
    }
  }
}
