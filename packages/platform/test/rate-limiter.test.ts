import { describe, expect, it } from 'vitest'
import { memoryRateLimiter } from '../src/index.ts'

const config = { ratePerSecond: 10, burst: 50 }

describe('memoryRateLimiter', () => {
  it('lets a burst through, then refuses with a retry time, and refills over time', async () => {
    const limiter = memoryRateLimiter()
    for (let i = 0; i < 50; i++) expect((await limiter.take('app_a', config, 0)).allowed).toBe(true)
    expect(await limiter.take('app_a', config, 0)).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 })
    expect(await limiter.take('app_a', config, 100)).toMatchObject({ allowed: true, remaining: 0 })
  })

  it('keeps one bucket per key', async () => {
    const limiter = memoryRateLimiter()
    for (let i = 0; i < 50; i++) await limiter.take('app_a', config, 0)
    expect((await limiter.take('app_a', config, 0)).allowed).toBe(false)
    expect((await limiter.take('app_b', config, 0)).allowed).toBe(true)
  })

  it('forgets buckets that have been full for longer than idleMs', async () => {
    const limiter = memoryRateLimiter({ idleMs: 60_000 })
    await limiter.take('app_a', config, 0)
    await limiter.take('app_b', config, 0)
    // app_b keeps being used; app_a has been full since 100 ms.
    await limiter.take('app_b', config, 59_000)
    expect(limiter.size()).toBe(2)
    await limiter.take('app_b', config, 61_000)
    expect(limiter.size()).toBe(1)
    // A forgotten bucket starts full again, so forgetting it changes nothing for the caller.
    expect(await limiter.take('app_a', config, 61_000)).toMatchObject({ allowed: true, remaining: 49 })
  })
})
