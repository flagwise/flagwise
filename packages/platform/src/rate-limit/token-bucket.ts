// Token-bucket rate limiting. Pure: the caller stores the state and passes the time.

export interface BucketConfig {
  readonly ratePerSecond: number
  readonly burst: number
}

export interface BucketState {
  readonly tokens: number
  readonly updatedAtMs: number
}

export interface TakeResult {
  readonly allowed: boolean
  readonly state: BucketState
  readonly remaining: number
  readonly retryAfterSeconds: number
}

/**
 * Takes `cost` tokens from a bucket.
 *
 * - `ratePerSecond` must be a finite number > 0, `burst` an integer >= 1 and `cost` an integer from
 *   1 to burst; otherwise RangeError.
 * - An undefined state is a new, full bucket (burst tokens) at `nowMs`.
 * - Refill first: `elapsed = max(0, nowMs - state.updatedAtMs)` (a clock that went backwards adds
 *   nothing), `tokens = min(burst, tokens + elapsed * ratePerSecond / 1000)`; the new `updatedAtMs`
 *   is `max(state.updatedAtMs, nowMs)`.
 * - Enough tokens: take them; `allowed` true, `retryAfterSeconds` 0. Otherwise take nothing;
 *   `allowed` false, `retryAfterSeconds = max(1, ceil((cost - tokens) / ratePerSecond))`.
 * - `remaining = floor(tokens)` after taking. The input state is never mutated.
 */
export function take(
  state: BucketState | undefined,
  config: BucketConfig,
  nowMs: number,
  cost = 1,
): TakeResult {
  const { ratePerSecond, burst } = config
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) throw new RangeError('ratePerSecond must be a finite number > 0')
  if (!Number.isInteger(burst) || burst < 1) throw new RangeError('burst must be an integer >= 1')
  if (!Number.isInteger(cost) || cost < 1 || cost > burst) throw new RangeError('cost must be an integer from 1 to burst')

  const prior: BucketState = state ?? { tokens: burst, updatedAtMs: nowMs }
  const elapsed = Math.max(0, nowMs - prior.updatedAtMs)
  const refilled = Math.min(burst, prior.tokens + (elapsed * ratePerSecond) / 1000)
  const updatedAtMs = Math.max(prior.updatedAtMs, nowMs)

  if (refilled >= cost) {
    const tokens = refilled - cost
    return { allowed: true, state: { tokens, updatedAtMs }, remaining: Math.floor(tokens), retryAfterSeconds: 0 }
  }
  return {
    allowed: false,
    state: { tokens: refilled, updatedAtMs },
    remaining: Math.floor(refilled),
    retryAfterSeconds: Math.max(1, Math.ceil((cost - refilled) / ratePerSecond)),
  }
}
