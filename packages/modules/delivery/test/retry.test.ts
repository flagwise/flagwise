import { describe, expect, it } from 'vitest'
import { RETRY_DELAYS_MS, endpointHealth, isDelivered, nextAttemptAt } from '../src/domain/retry.ts'

const T0 = new Date('2026-11-03T09:00:00.000Z')
const plus = (ms: number) => new Date(T0.getTime() + ms)
const S = 1_000
const MIN = 60 * S
const H = 60 * MIN
const DAY = 24 * H

describe('isDelivered', () => {
  it.each([
    [200, 120, true],
    [204, 9_999, true],
    [299, 10_000, true],
    [200, 10_001, false],
    [199, 50, false],
    [300, 50, false],
    [410, 50, false],
    [500, 50, false],
    [null, 10_000, false],
  ])('status %s after %i ms: %s', (status, durationMs, expected) => {
    expect(isDelivered({ status, durationMs })).toBe(expected)
  })
})

describe('nextAttemptAt', () => {
  it('keeps the documented schedule', () => {
    expect(RETRY_DELAYS_MS).toEqual([5 * S, 5 * MIN, 30 * MIN, 2 * H, 5 * H, 10 * H, 10 * H])
  })

  it.each([
    [1, 5 * S],
    [2, 5 * MIN],
    [3, 30 * MIN],
    [4, 2 * H],
    [5, 5 * H],
    [6, 10 * H],
    [7, 10 * H],
  ])('schedules the attempt after failed attempt %i', (n, delay) => {
    expect(nextAttemptAt(n, T0)).toEqual(plus(delay))
  })

  it('gives up after attempt 8', () => {
    expect(nextAttemptAt(8, T0)).toBeNull()
    expect(nextAttemptAt(9, T0)).toBeNull()
  })

  it('spans about 27 hours from first attempt to giving up when every attempt fails instantly', () => {
    let at = T0
    let n = 1
    for (let next = nextAttemptAt(n, at); next; next = nextAttemptAt(n, at)) {
      at = next
      n++
    }
    expect(n).toBe(8)
    expect(at.getTime() - T0.getTime()).toBe(27 * H + 35 * MIN + 5 * S)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects attempt number %s', (n) => {
    expect(() => nextAttemptAt(n, T0)).toThrow(RangeError)
  })
})

describe('endpointHealth', () => {
  const ok = (ms: number) => ({ at: plus(ms), delivered: true })
  const bad = (ms: number) => ({ at: plus(ms), delivered: false })

  it('is healthy with no attempts', () => {
    expect(endpointHealth([], plus(DAY))).toEqual({ status: 'healthy', failingSince: null, alert: false })
  })

  it('is healthy when the latest attempt succeeded', () => {
    expect(endpointHealth([bad(0), bad(MIN), ok(2 * MIN)], plus(10 * DAY))).toEqual({
      status: 'healthy',
      failingSince: null,
      alert: false,
    })
  })

  it('counts failure from the first failure after the last success', () => {
    const attempts = [ok(0), bad(10 * MIN), bad(20 * MIN), bad(50 * MIN)]
    expect(endpointHealth(attempts, plus(30 * MIN))).toEqual({ status: 'failing', failingSince: plus(10 * MIN), alert: false })
  })

  it('alerts after one hour of failing', () => {
    const attempts = [ok(0), bad(10 * MIN), bad(40 * MIN)]
    expect(endpointHealth(attempts, plus(70 * MIN - 1)).alert).toBe(false)
    expect(endpointHealth(attempts, plus(70 * MIN))).toEqual({ status: 'failing', failingSince: plus(10 * MIN), alert: true })
  })

  it('disables after five days of failing, still alerting', () => {
    const attempts = [bad(0), bad(DAY)]
    expect(endpointHealth(attempts, plus(5 * DAY - 1)).status).toBe('failing')
    expect(endpointHealth(attempts, plus(5 * DAY))).toEqual({ status: 'disabled', failingSince: T0, alert: true })
  })

  it('uses the first attempt ever when nothing succeeded', () => {
    expect(endpointHealth([bad(3 * H), bad(H), bad(2 * H)], plus(4 * H)).failingSince).toEqual(plus(H))
  })

  it('sorts attempts by time', () => {
    const attempts = [bad(50 * MIN), ok(0), bad(10 * MIN), ok(5 * MIN)]
    expect(endpointHealth(attempts, plus(2 * H))).toEqual({ status: 'failing', failingSince: plus(10 * MIN), alert: true })
    expect(endpointHealth([ok(2 * H), bad(0)], plus(3 * H)).status).toBe('healthy')
  })

  it('does not mutate the input', () => {
    const attempts = Object.freeze([bad(50 * MIN), ok(0)])
    expect(() => endpointHealth(attempts, plus(H))).not.toThrow()
    expect(attempts[0]?.at).toEqual(plus(50 * MIN))
  })
})
