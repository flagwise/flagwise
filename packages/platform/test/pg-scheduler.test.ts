// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type AppRef, type ManualClock } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, createPgScheduler, migrate, pgTimers, scopeOfApp, withApps, type Database, type FiredTimer, type Timers } from '../src/index.ts'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../src/testing/pg.ts'

const A: AppRef = { appId: 'app_a', livemode: true }
const B: AppRef = { appId: 'app_b', livemode: true }
const MIN = 60_000

describe.skipIf(!testDatabaseUrl)('Postgres scheduler', () => {
  let t: TestDatabase
  let db: Database
  let clock: ManualClock
  const timers = <R>(appRef: AppRef, fn: (timers: Timers) => Promise<R>, owner = 'moderation') => withApps(db, scopeOfApp(appRef), (tx) => fn(pgTimers(tx, owner)))
  const left = async () => (await db.system.execute<{ key: string }>(sql`SELECT key FROM platform.timers ORDER BY key`)).rows.map((r) => r.key)

  beforeEach(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    clock = manualClock('2026-11-20T09:00:00Z')
  })
  afterEach(async () => {
    await db?.close()
    await t?.drop()
  })

  it('fires due timers once, oldest first, to their owner, and deletes them', async () => {
    const fired: FiredTimer[] = []
    const scheduler = createPgScheduler(db, { clock })
    scheduler.on('moderation', async (timer) => void fired.push(timer))
    await timers(A, (x) => x.set(A, 'sla_breach:case_1', new Date(clock.now().getTime() + 10 * MIN), { caseId: 'case_1' }))
    await timers(B, (x) => x.set(B, 'sla_75:case_2', new Date(clock.now().getTime() + 5 * MIN)))
    await timers(A, (x) => x.set(A, 'other', new Date(clock.now().getTime() + MIN)), 'delivery')
    expect(await scheduler.runDue()).toBe(0)
    clock.advance(10 * MIN)
    expect(await scheduler.runDue()).toBe(2)
    expect(fired.map((f) => [f.appRef.appId, f.key, f.data, f.attempt])).toEqual([
      ['app_b', 'sla_75:case_2', {}, 1],
      ['app_a', 'sla_breach:case_1', { caseId: 'case_1' }, 1],
    ])
    // Only the owners handled here fire; delivery's timer waits for its own handler.
    expect(await left()).toEqual(['other'])
    expect(await scheduler.runDue()).toBe(0)
  })

  it('moves a timer set again, and cancels one that has not fired', async () => {
    const fired: string[] = []
    const scheduler = createPgScheduler(db, { clock })
    scheduler.on('moderation', async (timer) => void fired.push(`${timer.key}@${timer.dueAt.toISOString()}`))
    await timers(A, (x) => x.set(A, 'k1', new Date(clock.now().getTime() + MIN)))
    await timers(A, (x) => x.set(A, 'k1', new Date(clock.now().getTime() + 2 * MIN)))
    await timers(A, (x) => x.set(A, 'k2', new Date(clock.now().getTime() + MIN)))
    expect(await timers(A, (x) => x.cancel(A, 'k2'))).toBe(true)
    expect(await timers(A, (x) => x.cancel(A, 'k2'))).toBe(false)
    // An app sees only its own timers.
    expect(await timers(B, (x) => x.cancel(A, 'k1'))).toBe(false)
    clock.advance(MIN)
    expect(await scheduler.runDue()).toBe(0)
    clock.advance(MIN)
    expect(await scheduler.runDue()).toBe(1)
    expect(fired).toEqual(['k1@2026-11-20T09:02:00.000Z'])
  })

  it('tries a failing timer again after its delay, and keeps one set again while it fired', async () => {
    const errors: unknown[] = []
    let calls = 0
    const scheduler = createPgScheduler(db, { clock, retryDelayMs: () => MIN, onError: (e) => errors.push(e) })
    scheduler.on('moderation', async (timer) => {
      calls++
      if (timer.attempt === 1) throw new Error('down')
      // Set again while firing: the new setting stays.
      await timers(timer.appRef, (x) => x.set(timer.appRef, timer.key, new Date(clock.now().getTime() + 60 * MIN)))
    })
    await timers(A, (x) => x.set(A, 'k', clock.now()))
    expect(await scheduler.runDue()).toBe(1)
    expect(errors).toHaveLength(1)
    expect(await scheduler.runDue()).toBe(0)
    clock.advance(MIN)
    expect(await scheduler.runDue()).toBe(1)
    expect(calls).toBe(2)
    expect(await left()).toEqual(['k'])
  })

  it('does not cancel a timer while it fires', async () => {
    const scheduler = createPgScheduler(db, { clock })
    let cancelled: boolean | undefined
    scheduler.on('moderation', async (timer) => {
      cancelled = await timers(timer.appRef, (x) => x.cancel(timer.appRef, timer.key))
    })
    await timers(A, (x) => x.set(A, 'k', clock.now()))
    await scheduler.runDue()
    expect(cancelled).toBe(false)
    expect(await left()).toEqual([])
  })
})
