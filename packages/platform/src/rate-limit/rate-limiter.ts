// A rate limiter that keeps a token bucket per key. The memory driver suits one node; a shared
// store (Postgres or Valkey) replaces it when several nodes serve the API.

import { take, type BucketConfig, type BucketState, type TakeResult } from './token-bucket.ts'

export interface RateLimiter {
  /** Takes `cost` tokens (default 1) from the bucket of `key`, as `take` does. */
  take(key: string, config: BucketConfig, nowMs: number, cost?: number): Promise<TakeResult>
}

/**
 * Keeps buckets in a Map in this process. A bucket that has been full for longer than `idleMs`
 * (default 10 minutes) is forgotten on a later call, since a new bucket starts full anyway.
 */
export function memoryRateLimiter(opts: { readonly idleMs?: number } = {}): RateLimiter & { size(): number } {
  const idleMs = opts.idleMs ?? 600_000
  const buckets = new Map<string, { state: BucketState; fullAtMs: number }>()
  let sweptAtMs = 0

  const sweep = (nowMs: number) => {
    if (nowMs - sweptAtMs < idleMs) return
    sweptAtMs = nowMs
    for (const [key, b] of buckets) if (nowMs - b.fullAtMs > idleMs) buckets.delete(key)
  }

  return {
    async take(key, config, nowMs, cost = 1) {
      sweep(nowMs)
      const result = take(buckets.get(key)?.state, config, nowMs, cost)
      // When the bucket will be full again: tokens refill at ratePerSecond.
      const fullAtMs = result.state.updatedAtMs + ((config.burst - result.state.tokens) * 1000) / config.ratePerSecond
      buckets.set(key, { state: result.state, fullAtMs })
      return result
    },
    size: () => buckets.size,
  }
}
