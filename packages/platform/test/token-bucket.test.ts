import { describe, expect, it } from 'vitest'
import { take, type BucketState } from '../src/rate-limit/token-bucket.ts'

const FREE = { ratePerSecond: 10, burst: 50 }
const T = 1_762_161_164_000

/** Takes `n` times at the same instant, returning the last result. */
function drain(n: number, state: BucketState | undefined, now = T) {
  let r = take(state, FREE, now)
  for (let i = 1; i < n; i++) r = take(r.state, FREE, now)
  return r
}

describe('take', () => {
  it('starts full and takes one token', () => {
    expect(take(undefined, FREE, T)).toEqual({ allowed: true, state: { tokens: 49, updatedAtMs: T }, remaining: 49, retryAfterSeconds: 0 })
  })

  it('allows a burst of 50, then refuses', () => {
    const last = drain(50, undefined)
    expect(last).toMatchObject({ allowed: true, remaining: 0 })
    expect(take(last.state, FREE, T)).toEqual({ allowed: false, state: { tokens: 0, updatedAtMs: T }, remaining: 0, retryAfterSeconds: 1 })
  })

  it('refills at the configured rate', () => {
    const empty = drain(50, undefined).state
    expect(take(empty, FREE, T + 99).allowed).toBe(false)
    expect(take(empty, FREE, T + 100)).toEqual({ allowed: true, state: { tokens: 0, updatedAtMs: T + 100 }, remaining: 0, retryAfterSeconds: 0 })
    expect(take(empty, FREE, T + 1_000)).toMatchObject({ allowed: true, remaining: 9 })
  })

  it('never refills beyond the burst', () => {
    const r = take({ tokens: 10, updatedAtMs: T }, FREE, T + 3_600_000)
    expect(r.state).toEqual({ tokens: 49, updatedAtMs: T + 3_600_000 })
  })

  it('keeps fractional tokens and floors remaining', () => {
    const r = take({ tokens: 0, updatedAtMs: T }, FREE, T + 250)
    expect(r.state.tokens).toBeCloseTo(1.5, 10)
    expect(r.remaining).toBe(1)
  })

  it('stores the refilled tokens even when refusing', () => {
    expect(take({ tokens: 0, updatedAtMs: T }, FREE, T + 50)).toEqual({
      allowed: false,
      state: { tokens: 0.5, updatedAtMs: T + 50 },
      remaining: 0,
      retryAfterSeconds: 1,
    })
  })

  it('computes Retry-After in whole seconds, at least 1', () => {
    const slow = { ratePerSecond: 0.5, burst: 5 }
    expect(take({ tokens: 0, updatedAtMs: T }, slow, T).retryAfterSeconds).toBe(2)
    expect(take({ tokens: 0, updatedAtMs: T }, slow, T, 3).retryAfterSeconds).toBe(6)
    expect(take({ tokens: 2.5, updatedAtMs: T }, slow, T, 3).retryAfterSeconds).toBe(1)
    expect(take({ tokens: 0, updatedAtMs: T }, { ratePerSecond: 50, burst: 100 }, T, 100).retryAfterSeconds).toBe(2)
  })

  it('takes several tokens at once', () => {
    expect(take(undefined, FREE, T, 50)).toMatchObject({ allowed: true, remaining: 0 })
    expect(take({ tokens: 4, updatedAtMs: T }, FREE, T, 5)).toMatchObject({ allowed: false, state: { tokens: 4, updatedAtMs: T } })
  })

  it('ignores a clock that went backwards', () => {
    expect(take({ tokens: 3, updatedAtMs: T }, FREE, T - 10_000)).toEqual({
      allowed: true,
      state: { tokens: 2, updatedAtMs: T },
      remaining: 2,
      retryAfterSeconds: 0,
    })
  })

  it('does not mutate the given state', () => {
    const state = Object.freeze({ tokens: 5, updatedAtMs: T })
    take(state, FREE, T + 500)
    expect(state).toEqual({ tokens: 5, updatedAtMs: T })
  })

  it.each([
    [{ ratePerSecond: 0, burst: 10 }, 1],
    [{ ratePerSecond: -1, burst: 10 }, 1],
    [{ ratePerSecond: Number.POSITIVE_INFINITY, burst: 10 }, 1],
    [{ ratePerSecond: Number.NaN, burst: 10 }, 1],
    [{ ratePerSecond: 10, burst: 0 }, 1],
    [{ ratePerSecond: 10, burst: 2.5 }, 1],
    [FREE, 0],
    [FREE, 51],
    [FREE, 1.5],
  ])('rejects config %o with cost %s', (config, cost) => {
    expect(() => take(undefined, config, T, cost)).toThrow(RangeError)
  })
})
