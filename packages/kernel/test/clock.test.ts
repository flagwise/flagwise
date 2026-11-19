import { describe, expect, it } from 'vitest'
import { manualClock, systemClock } from '../src/index.ts'

describe('systemClock', () => {
  it('returns the current time', () => {
    const before = Date.now()
    const now = systemClock.now().getTime()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe('manualClock', () => {
  it('starts at a Date or an ISO string', () => {
    expect(manualClock(new Date('2026-11-03T09:00:00Z')).now().toISOString()).toBe('2026-11-03T09:00:00.000Z')
    expect(manualClock('2026-11-03T09:00:00Z').now().toISOString()).toBe('2026-11-03T09:00:00.000Z')
  })

  it('does not move on its own', () => {
    const clock = manualClock('2026-11-03T09:00:00Z')
    expect(clock.now().getTime()).toBe(clock.now().getTime())
  })

  it('advances by milliseconds, cumulatively', () => {
    const clock = manualClock('2026-11-03T09:00:00Z')
    clock.advance(1_000)
    clock.advance(59_000)
    expect(clock.now().toISOString()).toBe('2026-11-03T09:01:00.000Z')
    clock.advance(0)
    expect(clock.now().toISOString()).toBe('2026-11-03T09:01:00.000Z')
  })

  it('rejects a negative advance', () => {
    const clock = manualClock('2026-11-03T09:00:00Z')
    expect(() => clock.advance(-1)).toThrow(RangeError)
    expect(clock.now().toISOString()).toBe('2026-11-03T09:00:00.000Z')
  })

  it('can be set forward or backward', () => {
    const clock = manualClock('2026-11-03T09:00:00Z')
    clock.set('2027-01-01T00:00:00Z')
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z')
    clock.set(new Date('2020-01-01T00:00:00Z'))
    expect(clock.now().toISOString()).toBe('2020-01-01T00:00:00.000Z')
  })

  it('rejects invalid dates', () => {
    expect(() => manualClock('not-a-date')).toThrow(RangeError)
    const clock = manualClock('2026-11-03T09:00:00Z')
    expect(() => clock.set('not-a-date')).toThrow(RangeError)
    expect(clock.now().toISOString()).toBe('2026-11-03T09:00:00.000Z')
  })

  it('returns a fresh Date each time, so callers cannot change the clock', () => {
    const clock = manualClock('2026-11-03T09:00:00Z')
    const a = clock.now()
    a.setFullYear(1999)
    expect(clock.now().toISOString()).toBe('2026-11-03T09:00:00.000Z')
    expect(clock.now()).not.toBe(clock.now())
  })

  it('is not affected by changes to the start Date', () => {
    const start = new Date('2026-11-03T09:00:00Z')
    const clock = manualClock(start)
    start.setFullYear(1999)
    expect(clock.now().toISOString()).toBe('2026-11-03T09:00:00.000Z')
  })
})
