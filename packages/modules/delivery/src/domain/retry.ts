// Webhook delivery retries and endpoint health.

export const RETRY_DELAYS_MS: readonly number[] = [
  5_000, // 5 s
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 3_600_000, // 2 h
  5 * 3_600_000, // 5 h
  10 * 3_600_000, // 10 h
  10 * 3_600_000, // 10 h
]

export interface AttemptOutcome {
  readonly status: number | null
  readonly durationMs: number
}

export interface Attempt {
  readonly at: Date
  readonly delivered: boolean
}

export interface EndpointHealth {
  readonly status: 'healthy' | 'failing' | 'disabled'
  readonly failingSince: Date | null
  readonly alert: boolean
}

/** Delivered when the endpoint answered with a 2xx status within 10 seconds (`durationMs <= 10_000`); `status` is null when no response arrived. */
export function isDelivered(outcome: AttemptOutcome): boolean {
  return outcome.status !== null && outcome.status >= 200 && outcome.status < 300 && outcome.durationMs <= 10_000
}

/**
 * When to try again after `attemptNumber` failed. Attempt 1 is sent right away; after attempt n
 * fails the next is due `failedAt + RETRY_DELAYS_MS[n - 1]`. After attempt 8 fails, null: the
 * message is marked failed and only manual redelivery is left. `attemptNumber` must be an integer
 * >= 1, else RangeError.
 */
export function nextAttemptAt(attemptNumber: number, failedAt: Date): Date | null {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new RangeError('attemptNumber must be an integer >= 1')
  const delay = RETRY_DELAYS_MS[attemptNumber - 1]
  if (delay === undefined) return null
  return new Date(failedAt.getTime() + delay)
}

/**
 * Health of one endpoint from all its delivery attempts (any order; sorted by time here).
 *
 * The endpoint is failing when its most recent attempt failed; `failingSince` is the first failed
 * attempt after the last success (or the first attempt ever, if none succeeded).
 * - 'healthy': no attempts, or the most recent one succeeded (`failingSince` null);
 * - 'failing': failing for less than 5 days;
 * - 'disabled': failing for 5 days or more.
 * `alert` is true once failing for 1 hour or more, including when disabled.
 */
export function endpointHealth(attempts: readonly Attempt[], now: Date): EndpointHealth {
  const sorted = [...attempts].sort((a, b) => a.at.getTime() - b.at.getTime())
  const last = sorted[sorted.length - 1]
  if (!last || last.delivered) return { status: 'healthy', failingSince: null, alert: false }

  let firstFailure = last
  for (let i = sorted.length - 1; i >= 0; i--) {
    const attempt = sorted[i]!
    if (attempt.delivered) break
    firstFailure = attempt
  }
  const failingSince = firstFailure.at
  const failingMs = now.getTime() - failingSince.getTime()
  return {
    status: failingMs >= 5 * 86_400_000 ? 'disabled' : 'failing',
    failingSince,
    alert: failingMs >= 3_600_000,
  }
}
