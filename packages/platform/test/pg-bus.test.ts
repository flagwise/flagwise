// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type TenantRef } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, createPgBus, migrate, runInRequest, withTenant, type BusEvent, type Database, type EventContract, type PgBus, type PgBusOptions } from '../src/index.ts'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../src/testing/pg.ts'

const A: TenantRef = { orgId: 'org_a', appId: 'app_a', livemode: true }
const B: TenantRef = { orgId: 'org_b', appId: 'app_b', livemode: true }
let n = 0
const ev = (type: string, key: string, data: unknown = null, tenant: TenantRef = A, id = `evt_${++n}`): BusEvent => ({ id, type, key, data, tenant })

function recorder() {
  const calls: string[] = []
  const handler =
    (fail: (e: BusEvent, attempt: number) => unknown = () => false) =>
    async (e: BusEvent, ctx: { group: string; attempt: number }) => {
      calls.push(`${ctx.group}:${e.id}#${ctx.attempt}`)
      const f = fail(e, ctx.attempt)
      if (f) throw f instanceof Error || typeof f === 'string' ? f : new Error(`boom ${e.id}`)
    }
  return { calls, handler }
}

describe.skipIf(!testDatabaseUrl)('Postgres bus', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  const newBus = (opts: PgBusOptions = {}) => createPgBus(db, { retryDelayMs: () => 0, ...opts })

  beforeEach(async () => {
    n = 0
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = newBus()
  })
  afterEach(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
  })

  it('delivers matching events to each group once, only on drain', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('cases', ['report.received'], handler())
    bus.subscribe('audit', '*', handler())
    await bus.drain()
    expect(await bus.publish([ev('report.received', 'u_1'), ev('case.opened', 'case_1')])).toBe(2)
    expect(calls).toEqual([])
    expect(await bus.pending()).toBe(3)
    expect(await bus.drain()).toBe(3)
    expect([...calls].sort()).toEqual(['audit:evt_1#1', 'audit:evt_2#1', 'cases:evt_1#1'])
    expect(await bus.pending()).toBe(0)
  })

  it('logs events with sequence numbers and their tenant', async () => {
    await bus.publish(ev('a', 'k'))
    await bus.publish([ev('b', 'k', { x: 1 }, B), ev('c', 'j')])
    const log = await bus.log()
    expect(log.map((l) => [l.seq, l.event.id])).toEqual([
      [1, 'evt_1'],
      [2, 'evt_2'],
      [3, 'evt_3'],
    ])
    expect(log[1]?.event).toEqual({ id: 'evt_2', type: 'b', key: 'k', data: { x: 1 }, tenant: B })
  })

  it('ignores an event id that was already published', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler())
    await bus.drain()
    const e = ev('a', 'k')
    expect(await bus.publish(e)).toBe(1)
    expect(await bus.publish([e, { ...e, data: 'changed' }, ev('b', 'k')])).toBe(1)
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_2#1'])
    expect((await bus.log())[0]?.event.data).toBeNull()
  })

  it.each([
    ['an empty id', { id: '', type: 'a', key: 'k', data: null, tenant: A }],
    ['an empty key', { id: 'x', type: 'a', key: '', data: null, tenant: A }],
    ['no tenant', { id: 'x', type: 'a', key: 'k', data: null }],
  ])('refuses %s and publishes nothing from that call', async (_label, bad) => {
    await expect(bus.publish([ev('a', 'k'), bad as BusEvent])).rejects.toThrow(TypeError)
    expect(await bus.log()).toEqual([])
  })

  it('writes events in the given transaction, so they exist only if it commits', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler())
    await bus.drain()
    await expect(
      withTenant(db, { orgId: 'org_a', appIds: ['app_a'], livemode: true }, async (tx) => {
        await bus.publish(ev('a', 'k'), tx)
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    await withTenant(db, { orgId: 'org_a', appIds: ['app_a'], livemode: true }, (tx) => bus.publish(ev('b', 'k'), tx))
    await bus.drain()
    expect(calls).toEqual(['g:evt_2#1'])
  })

  it('lets the app role read only its own tenant events, and no deliveries', async () => {
    await bus.publish([ev('a', 'k', null, A), ev('b', 'k', null, B)])
    const mine = await withTenant(db, { orgId: 'org_a', appIds: ['app_a'], livemode: true }, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM platform.events ORDER BY seq`),
    )
    expect(mine.rows.map((r) => r.id)).toEqual(['evt_1'])
    const writeOther = withTenant(db, { orgId: 'org_a', appIds: ['app_a'], livemode: true }, (tx) => bus.publish(ev('c', 'k', null, B), tx))
    await expect(writeOther).rejects.toThrow()
    await expect(db.app.execute(sql`SELECT * FROM platform.deliveries`)).rejects.toThrow()
  })

  it('does not deliver past events to a new group', async () => {
    await bus.publish(ev('a', 'k'))
    const { calls, handler } = recorder()
    bus.subscribe('late', '*', handler())
    await bus.drain()
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    expect(calls).toEqual(['late:evt_2#1'])
  })

  it('refuses a group name twice, and bad types', () => {
    bus.subscribe('g', '*', () => {})
    expect(() => bus.subscribe('g', '*', () => {})).toThrow()
    expect(() => bus.subscribe('h', [], () => {})).toThrow(TypeError)
    expect(() => bus.subscribe('i', '*', () => {}, { maxAttempts: 0 })).toThrow(RangeError)
  })

  it('passes the group, sequence number, attempt and tenant', async () => {
    const seen: unknown[] = []
    bus.subscribe('g', '*', (e, ctx) => {
      seen.push({ ...ctx, tenant: e.tenant })
    })
    await bus.drain()
    await bus.publish([ev('a', 'k'), ev('b', 'k', null, B)])
    await bus.drain()
    expect(seen).toEqual([
      { group: 'g', seq: 1, attempt: 1, tenant: A },
      { group: 'g', seq: 2, attempt: 1, tenant: B },
    ])
  })

  it('keeps order per key and lets other keys go ahead of a failing one', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler((e, attempt) => e.id === 'evt_1' && attempt < 3))
    await bus.drain()
    await bus.publish([ev('a', 'k1'), ev('b', 'k1'), ev('c', 'k2')])
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_3#1', 'g:evt_1#2', 'g:evt_1#3', 'g:evt_2#1'])
  })

  it('isolates groups: one group failing does not hold back another', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('bad', '*', handler(() => true), { maxAttempts: 2 })
    bus.subscribe('good', '*', handler())
    await bus.drain()
    await bus.publish([ev('a', 'k'), ev('b', 'k')])
    await bus.drain()
    expect(calls.filter((c) => c.startsWith('good'))).toEqual(['good:evt_1#1', 'good:evt_2#1'])
  })

  it('delivers events published by a handler in the same drain', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('first', ['a'], async (e) => {
      await bus.publish(ev('b', e.key))
    })
    bus.subscribe('second', ['b'], handler())
    await bus.drain()
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    expect(calls).toEqual(['second:evt_2#1'])
  })

  it('dead-letters after maxAttempts with the error, and unblocks the key', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler((e) => (e.id === 'evt_1' ? 'not an Error' : false)), { maxAttempts: 3 })
    await bus.drain()
    await bus.publish([ev('a', 'k'), ev('b', 'k')])
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_1#2', 'g:evt_1#3', 'g:evt_2#1'])
    expect(await bus.deadLetters()).toEqual([{ group: 'g', seq: 1, attempts: 3, error: 'not an Error', event: ev('a', 'k', null, A, 'evt_1') }])
    expect(await bus.pending()).toBe(0)
  })

  it('uses 5 attempts by default and a per-bus override', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler(() => true))
    await bus.drain()
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    expect(calls).toHaveLength(5)
    expect(() => createPgBus(db, { maxAttempts: 0 })).toThrow(RangeError)
  })

  it('retries a dead letter from attempt 1, behind queued work for its key', async () => {
    let failing = true
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler((e) => failing && e.id === 'evt_1'), { maxAttempts: 1 })
    await bus.drain()
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    failing = false
    await bus.publish(ev('b', 'k'))
    expect(await bus.retryDeadLetter('g', 'evt_1')).toBe(true)
    expect(await bus.retryDeadLetter('g', 'evt_1')).toBe(false)
    expect(await bus.retryDeadLetter('nope', 'evt_1')).toBe(false)
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_2#1', 'g:evt_1#1'])
    expect(await bus.deadLetters()).toEqual([])
  })

  it('stops delivering after unsubscribe, drops queued work and keeps dead letters', async () => {
    const { calls, handler } = recorder()
    const off = bus.subscribe('g', '*', handler((e) => e.id === 'evt_1'), { maxAttempts: 1 })
    await bus.drain()
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    await bus.publish(ev('b', 'k'))
    off()
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1'])
    expect(await bus.pending('g')).toBe(0)
    expect((await bus.deadLetters()).map((d) => d.event.id)).toEqual(['evt_1'])
    expect(await bus.retryDeadLetter('g', 'evt_1')).toBe(false)
  })

  it('re-delivers logged events of the group types from a sequence number, and refuses an unknown group', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', ['a'], handler())
    await bus.drain()
    await bus.publish([ev('a', 'k'), ev('b', 'k'), ev('a', 'j')])
    await bus.drain()
    expect(await bus.replay('g', 2)).toBe(1)
    expect(await bus.replay('g')).toBe(2)
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_3#1', 'g:evt_3#1', 'g:evt_1#1', 'g:evt_3#1'])
    await expect(bus.replay('nope')).rejects.toThrow()
  })

  it('waits for a retry delay instead of retrying at once', async () => {
    const slow = newBus({ retryDelayMs: () => 60_000 })
    const { calls, handler } = recorder()
    slow.subscribe('g', '*', handler(() => true))
    await slow.drain()
    await slow.publish(ev('a', 'k'))
    expect(await slow.drain()).toBe(1)
    expect(calls).toEqual(['g:evt_1#1'])
    expect(await slow.pending('g')).toBe(1)
  })

  it('times retry waits by the given clock instead of the database', async () => {
    // Ahead of the database, so deliveries queued at the database's time are ready at once.
    const clock = manualClock(new Date(Date.now() + 60_000))
    const timed = newBus({ retryDelayMs: () => 300_000, clock })
    const { calls, handler } = recorder()
    timed.subscribe('g', '*', handler((_, attempt) => attempt === 1))
    await timed.drain()
    await timed.publish(ev('a', 'k'))
    expect(await timed.drain()).toBe(1)
    clock.advance(299_000)
    expect(await timed.drain()).toBe(0)
    clock.advance(1_000)
    expect(await timed.drain()).toBe(1)
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_1#2'])
    expect(await timed.pending('g')).toBe(0)
  })

  it('delivers each event once and keeps key order with two workers on one database', async () => {
    const seen: string[] = []
    const handler = async (e: BusEvent) => {
      seen.push(`${e.key}:${(e.data as { i: number }).i}`)
      await new Promise((r) => setTimeout(r, Math.random() * 3))
    }
    const other = newBus()
    bus.subscribe('g', '*', handler)
    other.subscribe('g', '*', handler)
    await Promise.all([bus.drain(), other.drain()])
    const events = Array.from({ length: 60 }, (_, i) => ev('a', `k${i % 4}`, { i }))
    await bus.publish(events)
    await Promise.all([bus.drain(), other.drain(), bus.drain(), other.drain()])
    expect(seen).toHaveLength(60)
    for (const key of ['k0', 'k1', 'k2', 'k3']) {
      const order = seen.filter((s) => s.startsWith(`${key}:`)).map((s) => Number(s.split(':')[1]))
      expect(order).toEqual([...order].sort((a, b) => a - b))
    }
  })

  it('hands a delivery to another worker when its lease runs out, and ignores the late result', async () => {
    let release!: () => void
    const stuck = new Promise<void>((r) => (release = r))
    let firstCalled!: () => void
    const called = new Promise<void>((r) => (firstCalled = r))
    // A timeout longer than the lease: the first worker behaves as if it crashed.
    const first = newBus({ leaseMs: 200, handlerTimeoutMs: 60_000 })
    first.subscribe('g', '*', async () => {
      firstCalled()
      await stuck
    })
    const attempts: number[] = []
    const second = newBus()
    second.subscribe('g', '*', (_e, ctx) => {
      attempts.push(ctx.attempt)
    })
    await first.drain()
    await second.drain()
    await first.publish(ev('a', 'k'))
    const draining = first.drain()
    await called
    expect(await second.drain()).toBe(0)
    await new Promise((r) => setTimeout(r, 300))
    expect(await second.drain()).toBe(1)
    expect(attempts).toEqual([2])
    release()
    await draining
    expect(await first.pending()).toBe(0)
    expect(await first.deadLetters()).toEqual([])
  })

  it('dead-letters a delivery whose lease ran out on its last attempt, without running it again', async () => {
    let release!: () => void
    const stuck = new Promise<void>((r) => (release = r))
    let firstCalled!: () => void
    const called = new Promise<void>((r) => (firstCalled = r))
    const first = newBus({ leaseMs: 200, handlerTimeoutMs: 60_000 })
    first.subscribe(
      'g',
      '*',
      async () => {
        firstCalled()
        await stuck
      },
      { maxAttempts: 1 },
    )
    const { calls, handler } = recorder()
    const second = newBus()
    second.subscribe('g', '*', handler(), { maxAttempts: 1 })
    await first.drain()
    await second.drain()
    await first.publish([ev('a', 'k'), ev('b', 'k')])
    const draining = first.drain()
    await called
    await new Promise((r) => setTimeout(r, 300))
    await second.drain()
    expect(calls).toEqual(['g:evt_2#1'])
    expect((await second.deadLetters()).map((d) => [d.event.id, d.attempts, d.error])).toEqual([['evt_1', 1, 'Lease expired before the handler finished']])
    release()
    await draining
    expect(await first.pending()).toBe(0)
    expect((await first.deadLetters()).map((d) => d.event.id)).toEqual(['evt_1'])
  })

  it('counts a handler call that runs past its timeout as a failed attempt', async () => {
    const quick = newBus({ handlerTimeoutMs: 50 })
    const attempts: number[] = []
    quick.subscribe('g', '*', (_e, ctx) => {
      attempts.push(ctx.attempt)
      return new Promise<void>(() => {})
    }, { maxAttempts: 2 })
    await quick.drain()
    await quick.publish(ev('a', 'k'))
    await quick.drain()
    expect(attempts).toEqual([1, 2])
    expect((await quick.deadLetters()).map((d) => d.error)).toEqual(['Handler timed out after 50 ms'])
    expect(() => createPgBus(db, { handlerTimeoutMs: 0 })).toThrow(RangeError)
  })

  it('polls and delivers after start(), until stop()', async () => {
    const { calls, handler } = recorder()
    const live = newBus({ pollMs: 20 })
    live.subscribe('g', '*', handler())
    live.start()
    await live.publish(ev('a', 'k'))
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual(['g:evt_1#1'])
    await live.stop()
    await live.publish(ev('b', 'k'))
    await new Promise((r) => setTimeout(r, 100))
    expect(calls).toEqual(['g:evt_1#1'])
  })

  it("stores the request an event was published in, and hands it to handlers with when it was published", async () => {
    const seen: unknown[] = []
    bus.subscribe('g', '*', (e) => void seen.push(e.meta))
    await bus.drain()
    await runInRequest({ requestId: 'req_1', actor: { type: 'api_key', id: 'key_1' } }, () => bus.publish(ev('a', 'k')))
    await withTenant(db, { orgId: A.orgId, appIds: [A.appId], livemode: A.livemode }, (tx) =>
      runInRequest({ actor: { type: 'operator', id: 'cli' } }, () => bus.publish(ev('b', 'k'), tx)),
    )
    await bus.publish(ev('c', 'k'))
    await bus.drain()
    expect(seen).toEqual([
      { requestId: 'req_1', actor: { type: 'api_key', id: 'key_1' }, publishedAt: expect.any(Date) },
      { actor: { type: 'operator', id: 'cli' }, publishedAt: expect.any(Date) },
      { publishedAt: expect.any(Date) },
    ])
  })

  describe('with a contract', () => {
    /** Knows order.placed.v1 at 1.2.0, whose data needs a string `orderId`; reads data as given. */
    const contract: EventContract & { seen: unknown[] } = {
      seen: [],
      versionOf(type, data) {
        contract.seen.push(data)
        if (type !== 'order.placed.v1') throw new TypeError(`${type} is not in the contract`)
        if (typeof (data as { orderId?: unknown } | null)?.orderId !== 'string') throw new TypeError('order.placed.v1 needs an orderId')
        return '1.2.0'
      },
    }

    it('stores each event with its schema version and hands it to handlers with it', async () => {
      const checked = newBus({ contract })
      const seen: BusEvent[] = []
      checked.subscribe('g', ['order.placed.v1'], (e) => void seen.push(e))
      await checked.drain()
      await checked.publish(ev('order.placed.v1', 'o1', { orderId: 'o1', at: new Date('2026-11-18T09:00:00Z') }))
      await checked.drain()
      expect(seen.map((e) => e.schemaVersion)).toEqual(['1.2.0'])
      expect((await checked.log()).map((l) => l.event.schemaVersion)).toEqual(['1.2.0'])
      expect(contract.seen.at(-1)).toEqual({ orderId: 'o1', at: '2026-11-18T09:00:00.000Z' })
    })

    it('publishes nothing of a call when one event breaks the contract, in a transaction or not', async () => {
      const checked = newBus({ contract })
      await expect(checked.publish([ev('order.placed.v1', 'o1', { orderId: 'o1' }), ev('order.placed.v1', 'o2', {})])).rejects.toThrow(/needs an orderId/)
      await expect(
        withTenant(db, { orgId: A.orgId, appIds: [A.appId], livemode: A.livemode }, (tx) => checked.publish([ev('order.placed.v1', 'o3', { orderId: 'o3' }), ev('order.placed', 'o4', { orderId: 'o4' })], tx)),
      ).rejects.toThrow(/not in the contract/)
      expect(await checked.log()).toEqual([])
    })

    it('keeps the version an event carries on a bus without one', async () => {
      await bus.publish([{ ...ev('a.b.v1', 'k'), schemaVersion: '1.0.3' }, ev('a.b.v1', 'k')])
      expect((await bus.log()).map((l) => l.event.schemaVersion)).toEqual(['1.0.3', undefined])
    })
  })

  it('moves events and consumer groups from before the event contracts to major 1', async () => {
    const owner = new pg.Client({ connectionString: t.ownerUrl })
    await owner.connect()
    try {
      // Back to before 0005: no schema versions, types without majors.
      await owner.query("DELETE FROM platform.schema_migrations WHERE module = 'platform' AND id = '0005_event_contracts'")
      await owner.query('ALTER TABLE platform.events DROP COLUMN schema_version')
      await owner.query('ALTER TABLE platform.events NO FORCE ROW LEVEL SECURITY')
      await owner.query(`INSERT INTO platform.events (id, type, key, data, org_id, app_id, livemode) VALUES
        ('e1', 'case.opened', 'k', '{}', 'org_a', 'app_a', true), ('e2', 'case.claimed.v2', 'k', '{}', 'org_a', 'app_a', true)`)
      await owner.query('ALTER TABLE platform.events FORCE ROW LEVEL SECURITY')
      await owner.query(`INSERT INTO platform.consumer_groups (name, types, max_attempts, since_seq) VALUES
        ('g1', '{case.opened,case.claimed.v2,case.decided}', 5, 0), ('g2', NULL, 5, 0)`)
      expect(await migrate(t.ownerUrl, [], t.roles)).toEqual(['platform/0005_event_contracts'])
      const forced = await owner.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = 'platform.events'::regclass")
      expect(forced.rows).toEqual([{ forced: true }])
      await owner.query('ALTER TABLE platform.events NO FORCE ROW LEVEL SECURITY')
      const events = await owner.query('SELECT id, type, schema_version FROM platform.events ORDER BY seq')
      expect(events.rows).toEqual([
        { id: 'e1', type: 'case.opened.v1', schema_version: '1.0.0' },
        { id: 'e2', type: 'case.claimed.v2', schema_version: null },
      ])
      const groups = await owner.query('SELECT name, types FROM platform.consumer_groups ORDER BY name')
      expect(groups.rows).toEqual([
        { name: 'g1', types: ['case.opened.v1', 'case.claimed.v2', 'case.decided.v1'] },
        { name: 'g2', types: null },
      ])
    } finally {
      await owner.end()
    }
  })
})
