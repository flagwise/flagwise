// Time source. Code depends on a Clock instead of calling `new Date()`, so tests can control time.

export interface Clock {
  now(): Date
}

export interface ManualClock extends Clock {
  advance(ms: number): void
  set(at: Date | string): void
}

/** The real clock. */
export const systemClock: Clock = {
  now() {
    return new Date()
  },
}

/**
 * A clock that only moves when told, starting at `start` (a Date or an ISO 8601 string).
 *
 * - `advance(ms)` moves it forward by `ms` milliseconds; a negative `ms` throws a RangeError.
 * - `set(at)` jumps to `at` (Date or ISO string), forward or backward.
 * - An invalid date (e.g. "not-a-date") passed to `manualClock` or `set` throws a RangeError.
 * - `now()` always returns a new Date, so mutating it never changes the clock.
 */
export function manualClock(start: Date | string): ManualClock {
  let ms = toMs(start)
  return {
    now: () => new Date(ms),
    advance(by: number) {
      if (!(by >= 0)) throw new RangeError(`Cannot advance a clock by ${by} ms`)
      ms += by
    },
    set(at: Date | string) {
      ms = toMs(at)
    },
  }
}

function toMs(at: Date | string): number {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at)
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date: ${String(at)}`)
  return ms
}
