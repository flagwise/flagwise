// Timers: a service's reminder to itself to look at something later (a case's SLA, an action
// request's deadline). The service sets a timer in the transaction of the change that needs it,
// cancels it when it is no longer needed, and handles it when it fires, in a transaction of its
// own. A timer says only that its time came; the handler checks whether it still matters.

import type { AppRef } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import type { AppTx } from '../db/database.ts'

export type TimerData = Readonly<Record<string, string>>

/** One service's timers, inside its transaction. Every method only sees timers of the given app and mode. */
export interface Timers {
  /** Sets the timer `key` to fire at `at` with `data`; a timer already set by that key moves. */
  set(appRef: AppRef, key: string, at: Date, data?: TimerData): Promise<void>
  /**
   * Cancels the timer `key`; true when it had not fired yet, so it never will. False when there is
   * none (it fired and was handled, or was never set) or it is firing right now.
   */
  cancel(appRef: AppRef, key: string): Promise<boolean>
}

export interface FiredTimer {
  readonly appRef: AppRef
  readonly key: string
  readonly dueAt: Date
  readonly data: TimerData
  /** 1 on the first try. */
  readonly attempt: number
}

/** Handles a fired timer; one that throws is tried again later. */
export type TimerHandler = (timer: FiredTimer) => Promise<void>

export interface Scheduler {
  /** Handles the timers of `owner` in this process; one handler per owner. */
  on(owner: string, handler: TimerHandler): void
  /** Fires every due timer of the owners handled here, until none is due; returns how many calls it made. */
  runDue(): Promise<number>
}

/** The timers of `owner` on Postgres, in the app transaction `tx` (see platform.timers). */
export function pgTimers(tx: AppTx, owner: string): Timers {
  return {
    async set(appRef, key, at, data = {}) {
      await tx.execute(sql`
        INSERT INTO platform.timers (app_id, livemode, owner, key, due_at, data)
        VALUES (${appRef.appId}, ${appRef.livemode}, ${owner}, ${key}, ${at.toISOString()}::timestamptz, ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (app_id, livemode, owner, key) DO UPDATE
          SET due_at = EXCLUDED.due_at, data = EXCLUDED.data, revision = nextval('platform.timer_revisions'),
              attempt = 0, retry_at = NULL, leased_until = NULL, last_error = NULL`)
    },
    async cancel(appRef, key) {
      const res = await tx.execute(sql`
        DELETE FROM platform.timers
         WHERE app_id = ${appRef.appId} AND livemode = ${appRef.livemode} AND owner = ${owner} AND key = ${key} AND leased_until IS NULL
        RETURNING key`)
      return res.rows.length > 0
    },
  }
}

interface MemoryTimer {
  readonly appRef: AppRef
  readonly owner: string
  readonly key: string
  readonly dueAt: Date
  readonly data: TimerData
}

/**
 * Timers in memory, for tests: `timers(owner)` gives an owner's Timers, `fireDue(now)` calls the
 * handlers of every timer due at `now`, in due order, and drops the ones handled.
 */
export function memoryScheduler(): Scheduler & { timers(owner: string): Timers; fireDue(now: Date): Promise<number>; list(): readonly MemoryTimer[] } {
  const all = new Map<string, MemoryTimer>()
  const handlers = new Map<string, TimerHandler>()
  const id = (appRef: AppRef, owner: string, key: string) => `${appRef.appId}|${appRef.livemode}|${owner}|${key}`
  const fireDue = async (now: Date) => {
    let calls = 0
    const due = [...all.entries()].filter(([, t]) => t.dueAt.getTime() <= now.getTime() && handlers.has(t.owner)).sort(([, a], [, b]) => a.dueAt.getTime() - b.dueAt.getTime())
    for (const [k, t] of due) {
      if (all.get(k) !== t) continue
      await handlers.get(t.owner)!({ appRef: t.appRef, key: t.key, dueAt: t.dueAt, data: t.data, attempt: 1 })
      calls++
      if (all.get(k) === t) all.delete(k)
    }
    return calls
  }
  return {
    on(owner, handler) {
      if (handlers.has(owner)) throw new Error(`Timers of ${owner} already have a handler`)
      handlers.set(owner, handler)
    },
    runDue: () => fireDue(new Date()),
    fireDue,
    list: () => [...all.values()],
    timers: (owner) => ({
      async set(appRef, key, at, data = {}) {
        all.set(id(appRef, owner, key), { appRef, owner, key, dueAt: at, data })
      },
      async cancel(appRef, key) {
        return all.delete(id(appRef, owner, key))
      },
    }),
  }
}
