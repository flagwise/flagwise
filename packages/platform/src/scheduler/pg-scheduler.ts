// Fires the due timers of platform.timers to their owners' handlers, as the system role. The
// handlers open their own app transactions.

import type { Clock } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import type { Database } from '../db/database.ts'
import type { Scheduler, TimerData, TimerHandler } from './timers.ts'

export interface PgSchedulerOptions {
  /** The time timers are due by; default the database's now(). */
  readonly clock?: Clock
  /** How long a worker holds a fired timer before another may fire it again; default 60 s. */
  readonly leaseMs?: number
  /** Delay before trying a timer again after its attempt `attempt` failed; default 1 s doubling, at most 5 min. */
  readonly retryDelayMs?: (attempt: number) => number
  /** How often start() looks for due timers; default 1 s. */
  readonly pollMs?: number
  /** Reports handler failures and errors of the polling loop. */
  readonly onError?: (err: unknown) => void
}

export interface PgScheduler extends Scheduler {
  /** Fires due timers every `pollMs` until stop(); a second call does nothing. */
  start(): void
  /** Stops polling and waits for the timers firing now. */
  stop(): Promise<void>
}

type Leased = { app_id: string; livemode: boolean; owner: string; key: string; due_at: Date | string; data: TimerData; revision: string; attempt: number }

const defaultDelay = (attempt: number) => Math.min(300_000, 1000 * 2 ** (attempt - 1))

/**
 * A scheduler over platform.timers. runDue() leases the due timers of the owners handled here (due
 * at or before now, not leased, or leased and the lease ran out), oldest first, and calls each
 * owner's handler. A handled timer is deleted unless it was set again meanwhile; one whose handler
 * throws fires again after `retryDelayMs(attempt)`, with no limit, and the error goes to onError.
 * Two workers never fire the same timer at once while its lease lasts.
 */
export function createPgScheduler(db: Database, opts: PgSchedulerOptions = {}): PgScheduler {
  const leaseMs = opts.leaseMs ?? 60_000
  const retryDelayMs = opts.retryDelayMs ?? defaultDelay
  const pollMs = opts.pollMs ?? 1_000
  const now = () => (opts.clock ? sql`${opts.clock.now().toISOString()}::timestamptz` : sql`now()`)
  const handlers = new Map<string, TimerHandler>()
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<unknown> = Promise.resolve()

  const lease = async (): Promise<Leased[]> => {
    const owners = [...handlers.keys()]
    if (owners.length === 0) return []
    const at = now()
    const res = await db.system.execute<Leased>(sql`
      UPDATE platform.timers t
         SET attempt = t.attempt + 1, leased_until = ${at} + ${`${leaseMs} milliseconds`}::interval
        FROM (SELECT app_id, livemode, owner, key FROM platform.timers
               WHERE owner IN (${sql.join(owners.map((o) => sql`${o}`), sql`, `)})
                 AND COALESCE(retry_at, due_at) <= ${at} AND (leased_until IS NULL OR leased_until < ${at})
               ORDER BY COALESCE(retry_at, due_at) LIMIT 100 FOR UPDATE SKIP LOCKED) due
       WHERE t.app_id = due.app_id AND t.livemode = due.livemode AND t.owner = due.owner AND t.key = due.key
      RETURNING t.app_id, t.livemode, t.owner, t.key, t.due_at, t.data, t.revision, t.attempt`)
    return [...res.rows].sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
  }

  const fire = async (t: Leased) => {
    const where = sql`app_id = ${t.app_id} AND livemode = ${t.livemode} AND owner = ${t.owner} AND key = ${t.key} AND revision = ${t.revision}`
    try {
      await handlers.get(t.owner)!({ appRef: { appId: t.app_id, livemode: t.livemode }, key: t.key, dueAt: new Date(t.due_at), data: t.data, attempt: t.attempt })
    } catch (err) {
      opts.onError?.(err)
      await db.system.execute(sql`
        UPDATE platform.timers SET leased_until = NULL, last_error = ${err instanceof Error ? err.message : String(err)},
               retry_at = ${now()} + ${`${Math.max(0, Math.round(retryDelayMs(t.attempt)))} milliseconds`}::interval
         WHERE ${where}`)
      return
    }
    await db.system.execute(sql`DELETE FROM platform.timers WHERE ${where}`)
  }

  const runDue = async () => {
    let calls = 0
    for (;;) {
      const batch = await lease()
      if (batch.length === 0) return calls
      for (const t of batch) await fire(t)
      calls += batch.length
    }
  }

  return {
    on(owner, handler) {
      if (handlers.has(owner)) throw new Error(`Timers of ${owner} already have a handler`)
      handlers.set(owner, handler)
    },
    runDue,
    start() {
      if (!stopped) return
      stopped = false
      const tick = () => {
        if (stopped) return
        running = runDue()
          .catch((err) => opts.onError?.(err))
          .then(() => {
            if (!stopped) timer = setTimeout(tick, pollMs)
          })
      }
      tick()
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
  }
}
