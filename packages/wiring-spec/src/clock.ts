// The install's clock: real time plus an offset that only grows, so it never falls behind the
// database (a delivery queued at the database's time is ready at once) and a scenario can skip
// ahead, such as to the next LLM retry, without waiting.

import type { Clock } from '@flagwise/kernel'

export interface SkippingClock extends Clock {
  /** Moves the clock ahead by `ms`. */
  advance(ms: number): void
}

export function skippingClock(): SkippingClock {
  let offset = 0
  return {
    now: () => new Date(Date.now() + offset),
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError(`Cannot move the clock back (${ms} ms)`)
      offset += ms
    },
  }
}
