// The Postgres event bus driver. It honours the same contract as the memory bus: at-least-once
// delivery, ordering per key within a consumer group, maxAttempts, dead letters and replay. The
// event log doubles as the outbox, so an event is published exactly when the transaction that
// wrote it commits. Fan-out and delivery run as the system role; handlers open their own tenant
// transactions.

import type { Clock, TenantRef } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import { withSystem, withTenant, type Database, type SystemTx, type TenantTx } from '../db/tenant.ts'
import { checkedEvent, deadLetteredEvent, fannedOutEvent, type BusEvent, type DeadLetter, type EventBus, type EventContract, type Handler } from './memory-bus.ts'
import { stampRequest, type EventMeta } from './request-context.ts'

export interface PgBusOptions {
  /** Default attempts per delivery; integer >= 1, default 5. */
  readonly maxAttempts?: number
  /** Delay before attempt `attempt + 1` after attempt `attempt` failed; default 1 s doubling, at most 5 min. */
  readonly retryDelayMs?: (attempt: number) => number
  /** How long a worker holds a delivery before another may take it over; default 60 s. */
  readonly leaseMs?: number
  /**
   * A handler call still running after this long counts as a failed attempt; default `leaseMs`.
   * The call is not cancelled, so a longer timeout lets two workers run the same delivery at once.
   */
  readonly handlerTimeoutMs?: number
  /** How often start() looks for work; default 250 ms. */
  readonly pollMs?: number
  /** Reports errors of the polling loop started by start(). */
  readonly onError?: (err: unknown) => void
  /**
   * The time for retry waits and leases; default the database's now(). With a clock, a delivery
   * queued at the database's time is ready once the clock reaches that time, so a clock behind the
   * database holds new deliveries back.
   */
  readonly clock?: Clock
  /**
   * The event types it may publish: every event is checked against it before any of a call is
   * written, and stored with its schema version. Without one, events keep the version they carry.
   */
  readonly contract?: EventContract
  /**
   * How long an event stays in the log once every group has handled it (no delivery or dead
   * letter left for it); default 7 days, null keeps every event. Replay reaches back only this far,
   * and an event id is only recognised again while its event is kept.
   */
  readonly retentionMs?: number | null
  /** How often start() deletes events past retention; default 1 hour. */
  readonly purgeEveryMs?: number
}

export interface PgBus extends EventBus {
  /** Deletes the events past retention now; returns how many. Nothing without a retention. */
  purge(): Promise<number>
  log(): Promise<{ seq: number; event: BusEvent }[]>
  pending(group?: string): Promise<number>
  deadLetters(): Promise<DeadLetter[]>
  retryDeadLetter(group: string, eventId: string): Promise<boolean>
  replay(group: string, fromSeq?: number): Promise<number>
  /** Polls for work until stop(); a second call does nothing. */
  start(): void
  /** Stops polling and waits for the deliveries in progress. */
  stop(): Promise<void>
}

interface Group {
  readonly name: string
  readonly types: readonly string[] | null
  readonly handler: Handler
  readonly maxAttempts: number
  readonly retryDelayMs: (attempt: number) => number
  registered: boolean
}

type Leased = {
  queued: string
  group_name: string
  seq: string
  attempt: number
  id: string
  type: string
  key: string
  data: unknown
  schema_version: string | null
  org_id: string
  app_id: string
  livemode: boolean
  created_at: Date | string
  request_id: string | null
  actor_type: string | null
  actor_id: string | null
  tracked: boolean
}

/** The identity of a stored event, enough to name it in the bus's facts. */
type Named = { id: string; type: string; key: string; org_id: string; app_id: string; livemode: boolean }
const named = (r: Named): BusEvent => ({ id: r.id, type: r.type, key: r.key, data: null, tenant: { orgId: r.org_id, appId: r.app_id, livemode: r.livemode } })

/** The meta of a stored event: its request and actor when it has them, and when it was published. */
const metaOf = (r: { request_id: string | null; actor_type: string | null; actor_id: string | null }, publishedAt?: Date | string): EventMeta | undefined => {
  const meta: EventMeta = {
    ...(r.request_id !== null && { requestId: r.request_id }),
    ...(r.actor_type !== null && r.actor_id !== null && { actor: { type: r.actor_type, id: r.actor_id } }),
    ...(publishedAt !== undefined && { publishedAt: new Date(publishedAt) }),
  }
  return Object.keys(meta).length ? meta : undefined
}

const FAN_OUT_LOCK = 0x6677_6275 // "fwbu"

const defaultDelay = (attempt: number) => Math.min(300_000, 1000 * 2 ** (attempt - 1))

/**
 * A bus over `db`, using the tables of platformMigrations.
 *
 * Publishing: every event needs non-empty string id, type and key and a `tenant`, else a TypeError
 * and nothing from that call is published. With `tx` the events are written in that transaction;
 * without it, in one transaction per tenant. An event id already in the log is ignored. Returns how
 * many events were new. With a `contract`, each event is checked against it first and stored with
 * its schema version; an event that fails throws and nothing from that call is published.
 *
 * Subscribing: one handler per consumer group in this process; types is a non-empty array or '*';
 * a group name already subscribed here throws. The group is stored on the next drain() or poll and
 * from then receives events with a higher sequence number than the newest one at that moment. The
 * returned function unsubscribes: the group and its queued deliveries are deleted (on the next
 * drain or poll), its dead letters stay.
 *
 * Delivering: each event is queued once per group whose types match, in sequence order (one
 * worker at a time queues new events). An event whose transaction commits after a later event's
 * was queued is queued after it. Within a group, deliveries
 * with the same key run strictly in queue order, one at a time, across every process: only the head
 * of a key is leased (for `leaseMs`), and a key whose head is leased or waiting for a retry is
 * skipped. A handler call that throws or rejects is a failure; when its attempt reaches the group's
 * maxAttempts the delivery moves to the dead letters, which unblocks the key, else it is retried
 * after the group's `retryDelayMs(attempt)` (from subscribe, else the bus's). A handler call running longer than `handlerTimeoutMs` is a failure
 * too. A lease that runs out (a crashed worker) makes the delivery available again, counting the
 * lost attempt; when that was the last attempt, the delivery moves to the dead letters instead.
 *
 * Tracking: queuing a tracked event (BusEvent.track) writes its `bus.event_fanned_out`, naming
 * every group it was queued for, in the same transaction; dead-lettering a delivery of one writes
 * `bus.delivery_dead_lettered` with the dead letter. Both carry the event's tenant and key.
 *
 * Retention: purge() deletes events older than `retentionMs` that every group has handled (none
 * of their deliveries or dead letters is left); start() runs it every `purgeEveryMs`.
 *
 * drain() works in rounds until a round finds nothing ready: queue new events, then for every
 * group of this process in subscription order, lease the ready heads and call the handler for each
 * in queue order. Events published by a handler are delivered in the same drain(). Returns how many
 * handler calls it made.
 *
 * Inspecting and repairing: `log()` in sequence order, `pending(group?)` (queued deliveries,
 * including ones waiting for a retry), `deadLetters()` in dead-letter order; `retryDeadLetter(group,
 * eventId)` queues the latest dead letter of that event again from attempt 1, behind what is already
 * queued for its key (false when there is none or the group is not stored); `replay(group, fromSeq
 * = 1)` queues again every logged event from `fromSeq` that the group's types match, and returns
 * the count; an unknown group throws.
 */
export function createPgBus(db: Database, opts: PgBusOptions = {}): PgBus {
  const defaultAttempts = opts.maxAttempts ?? 5
  if (!Number.isInteger(defaultAttempts) || defaultAttempts < 1) throw new RangeError('maxAttempts must be an integer >= 1')
  const retryDelayMs = opts.retryDelayMs ?? defaultDelay
  const leaseMs = opts.leaseMs ?? 60_000
  const pollMs = opts.pollMs ?? 250
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? leaseMs
  if (!(handlerTimeoutMs > 0)) throw new RangeError('handlerTimeoutMs must be > 0')
  const clock = opts.clock
  const retentionMs = opts.retentionMs === undefined ? 7 * 24 * 3_600_000 : opts.retentionMs
  const purgeEveryMs = opts.purgeEveryMs ?? 3_600_000
  let lastPurge = 0
  const now = () => (clock ? sql`${clock.now().toISOString()}::timestamptz` : sql`now()`)

  const groups = new Map<string, Group>()
  const dropped = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<unknown> = Promise.resolve()
  let stopped = true

  const sync = async () => {
    for (const name of dropped) {
      await db.system.execute(sql`DELETE FROM platform.consumer_groups WHERE name = ${name}`)
      dropped.delete(name)
    }
    for (const g of groups.values()) {
      if (g.registered) continue
      await db.system.execute(sql`
        INSERT INTO platform.consumer_groups (name, types, max_attempts, since_seq)
        VALUES (${g.name}, ${g.types === null ? null : sql`${toPgArray(g.types)}::text[]`}, ${g.maxAttempts},
                (SELECT COALESCE(max(seq), 0) FROM platform.events))
        ON CONFLICT (name) DO UPDATE SET types = EXCLUDED.types, max_attempts = EXCLUDED.max_attempts`)
      g.registered = true
    }
  }

  const fanOut = async (): Promise<number> => {
    let total = 0
    for (;;) {
      // One worker at a time, so deliveries are queued in sequence order.
      const res = await withSystem(db, async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FAN_OUT_LOCK})`)
        const batch = await tx.execute<Named & { seq: string; tracked: boolean; groups: string[] | null }>(sql`
          WITH batch AS (
            SELECT seq, type, key FROM platform.events WHERE NOT fanned_out ORDER BY seq LIMIT 500
          ), queued AS (
            INSERT INTO platform.deliveries (group_name, seq, key)
            SELECT g.name, b.seq, b.key FROM batch b
              JOIN platform.consumer_groups g ON b.seq > g.since_seq AND (g.types IS NULL OR b.type = ANY (g.types))
             ORDER BY b.seq, g.position
            RETURNING group_name, seq
          ), marked AS (
            UPDATE platform.events e SET fanned_out = true FROM batch b WHERE e.seq = b.seq
            RETURNING e.seq, e.tracked, ${STORED_NAMED}
          )
          SELECT m.*, (SELECT array_agg(q.group_name) FROM queued q WHERE q.seq = m.seq) AS groups FROM marked m`)
        const tracked = batch.rows.filter((r) => r.tracked)
        if (tracked.length) await insertSystem(tx, tracked.map((r) => fannedOutEvent(named(r), r.groups ?? [])))
        return batch
      })
      total += res.rows.length
      if (res.rows.length < 500) return total
    }
  }

  /** Leases the ready head of every key of a group, in queue order. */
  const lease = async (group: Group): Promise<Leased[]> => {
    // A lease that ran out on the last attempt means the worker crashed or the handler never
    // finished: dead-letter it instead of running it again, so a poison event cannot loop forever.
    const at = now()
    await withSystem(db, async (tx) => {
      const dead = await tx.execute<Named & { dl: string; attempts: number; error: string }>(sql`
        WITH expired AS (
          DELETE FROM platform.deliveries
           WHERE group_name = ${group.name} AND leased_until < ${at} AND attempt >= ${group.maxAttempts}
          RETURNING group_name, seq, attempt
        ), letters AS (
          INSERT INTO platform.dead_letters (group_name, seq, attempts, error)
          SELECT group_name, seq, attempt, ${'Lease expired before the handler finished'} FROM expired
          RETURNING id, seq, attempts, error
        )
        SELECT l.id AS dl, l.attempts, l.error, ${STORED_NAMED} FROM letters l JOIN platform.events e ON e.seq = l.seq WHERE e.tracked`)
      for (const r of dead.rows) await insertSystem(tx, [deadLetteredEvent(named(r), group.name, r.attempts, r.error, r.dl)])
    })
    const res = await db.system.execute<Leased>(sql`
      WITH heads AS (
        SELECT DISTINCT ON (key) queued, key, available_at, leased_until FROM platform.deliveries
         WHERE group_name = ${group.name} ORDER BY key, queued
      ), leased AS (
        UPDATE platform.deliveries d
           SET attempt = d.attempt + 1, leased_until = ${at} + ${`${leaseMs} milliseconds`}::interval
          FROM heads h
         WHERE d.queued = h.queued AND h.available_at <= ${at} AND (h.leased_until IS NULL OR h.leased_until < ${at})
           AND (d.leased_until IS NULL OR d.leased_until < ${at})
        RETURNING d.queued, d.group_name, d.seq, d.attempt
      )
      SELECT l.queued, l.group_name, l.seq, l.attempt, e.id, e.type, e.key, e.data, e.schema_version, e.org_id, e.app_id, e.livemode,
             e.created_at, e.request_id, e.actor_type, e.actor_id, e.tracked
        FROM leased l JOIN platform.events e ON e.seq = l.seq ORDER BY l.queued`)
    return res.rows
  }

  const settle = async (group: Group, d: Leased, error: string | null) => {
    if (error === null) {
      await db.system.execute(sql`DELETE FROM platform.deliveries WHERE queued = ${d.queued} AND attempt = ${d.attempt}`)
    } else if (d.attempt >= group.maxAttempts) {
      await withSystem(db, async (tx) => {
        const gone = await tx.execute(sql`DELETE FROM platform.deliveries WHERE queued = ${d.queued} AND attempt = ${d.attempt} RETURNING queued`)
        if (!gone.rows.length) return
        const letter = await tx.execute<{ id: string }>(
          sql`INSERT INTO platform.dead_letters (group_name, seq, attempts, error) VALUES (${group.name}, ${d.seq}, ${d.attempt}, ${error}) RETURNING id`,
        )
        if (d.tracked) await insertSystem(tx, [deadLetteredEvent(named(d), group.name, d.attempt, error, letter.rows[0]!.id)])
      })
    } else {
      await db.system.execute(sql`
        UPDATE platform.deliveries SET leased_until = NULL, last_error = ${error},
               available_at = ${now()} + ${`${Math.max(0, Math.round(group.retryDelayMs(d.attempt)))} milliseconds`}::interval
         WHERE queued = ${d.queued} AND attempt = ${d.attempt}`)
    }
  }

  const deliver = async (group: Group, d: Leased) => {
    const event: BusEvent = {
      id: d.id,
      type: d.type,
      key: d.key,
      data: d.data,
      tenant: { orgId: d.org_id, appId: d.app_id, livemode: d.livemode },
      meta: metaOf(d, d.created_at)!,
      ...(d.schema_version !== null && { schemaVersion: d.schema_version }),
    }
    let error: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Handler timed out after ${handlerTimeoutMs} ms`)), handlerTimeoutMs)
    })
    try {
      await Promise.race([Promise.resolve().then(() => group.handler(event, { group: group.name, seq: Number(d.seq), attempt: d.attempt })), timeout])
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      clearTimeout(timer)
    }
    await settle(group, d, error)
  }

  /** One round: queue new events, then deliver the ready heads of every local group. */
  const round = async (): Promise<{ queued: number; calls: number }> => {
    await sync()
    const queued = await fanOut()
    let calls = 0
    for (const group of [...groups.values()]) {
      if (!groups.has(group.name)) continue
      for (const d of await lease(group)) {
        await deliver(group, d)
        calls++
      }
    }
    return { queued, calls }
  }

  const insertEvents = async (tx: TenantTx, events: readonly BusEvent[]): Promise<number> => {
    let fresh = 0
    for (const published of events) {
      const e = stampRequest(published)
      const t = e.tenant!
      const m = e.meta
      const res = await tx.execute(sql`
        INSERT INTO platform.events (id, type, key, data, schema_version, org_id, app_id, livemode, request_id, actor_type, actor_id, tracked)
        VALUES (${e.id}, ${e.type}, ${e.key}, ${JSON.stringify(e.data ?? null)}::jsonb, ${e.schemaVersion ?? null}, ${t.orgId}, ${t.appId}, ${t.livemode},
                ${m?.requestId ?? null}, ${m?.actor?.type ?? null}, ${m?.actor?.id ?? null}, ${e.track === true})
        ON CONFLICT (id) DO NOTHING RETURNING seq`)
      fresh += res.rows.length
    }
    return fresh
  }

  /** The bus's own facts, written by the system role in its transaction; checked like any event. */
  const insertSystem = async (tx: SystemTx, events: readonly BusEvent[]) => {
    for (const given of events) {
      const e = checkedEvent(given, opts.contract)
      const t = e.tenant!
      await tx.execute(sql`
        INSERT INTO platform.events (id, type, key, data, schema_version, org_id, app_id, livemode)
        VALUES (${e.id}, ${e.type}, ${e.key}, ${JSON.stringify(e.data ?? null)}::jsonb, ${e.schemaVersion ?? null}, ${t.orgId}, ${t.appId}, ${t.livemode})
        ON CONFLICT (id) DO NOTHING`)
    }
  }

  const purge = async (): Promise<number> => {
    if (retentionMs === null) return 0
    const res = await db.system.execute(sql`
      DELETE FROM platform.events e
       WHERE e.fanned_out AND e.created_at < ${now()} - ${`${retentionMs} milliseconds`}::interval
         AND NOT EXISTS (SELECT 1 FROM platform.deliveries d WHERE d.seq = e.seq)
         AND NOT EXISTS (SELECT 1 FROM platform.dead_letters l WHERE l.seq = e.seq)
      RETURNING e.seq`)
    return res.rows.length
  }

  const groupRow = async (name: string) =>
    (await db.system.execute<{ types: string[] | null }>(sql`SELECT types FROM platform.consumer_groups WHERE name = ${name}`)).rows[0]

  const bus: PgBus = {
    purge,

    async publish(input, tx) {
      const given = (Array.isArray(input) ? input : [input]) as readonly BusEvent[]
      for (const e of given) {
        for (const field of ['id', 'type', 'key'] as const) {
          if (typeof e?.[field] !== 'string' || e[field] === '') throw new TypeError(`Every event needs a non-empty string ${field}`)
        }
        if (!e.tenant) throw new TypeError(`Event ${e.id} has no tenant`)
      }
      const events = given.map((e) => checkedEvent(e, opts.contract))
      if (tx) return insertEvents(tx, events)
      const byTenant = new Map<string, { tenant: TenantRef; events: BusEvent[] }>()
      for (const e of events) {
        const k = `${e.tenant!.orgId}|${e.tenant!.appId}|${e.tenant!.livemode}`
        const entry = byTenant.get(k) ?? { tenant: e.tenant!, events: [] }
        entry.events.push(e)
        byTenant.set(k, entry)
      }
      let fresh = 0
      for (const { tenant, events: list } of byTenant.values()) {
        fresh += await withTenant(db, { orgId: tenant.orgId, appIds: [tenant.appId], livemode: tenant.livemode }, (t) => insertEvents(t, list))
      }
      return fresh
    },

    subscribe(name, types, handler, subOpts) {
      if (groups.has(name)) throw new Error(`Group ${name} is already subscribed`)
      if (typeof name !== 'string' || name === '') throw new TypeError('A group needs a non-empty name')
      if (types !== '*' && (!Array.isArray(types) || types.length === 0)) throw new TypeError("types must be '*' or a non-empty array")
      const maxAttempts = subOpts?.maxAttempts ?? defaultAttempts
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be an integer >= 1')
      dropped.delete(name)
      groups.set(name, { name, types: types === '*' ? null : [...types], handler, maxAttempts, retryDelayMs: subOpts?.retryDelayMs ?? retryDelayMs, registered: false })
      return () => {
        if (groups.delete(name)) dropped.add(name)
      }
    },

    async drain() {
      let calls = 0
      for (;;) {
        const r = await round()
        calls += r.calls
        if (r.calls === 0 && r.queued === 0) return calls
      }
    },

    async log() {
      const res = await db.system.execute<StoredRow & { seq: string }>(sql`SELECT seq, ${STORED} FROM platform.events ORDER BY seq`)
      return res.rows.map((r) => ({ seq: Number(r.seq), event: storedEvent(r) }))
    },

    async pending(group) {
      await sync()
      await fanOut()
      const res = await db.system.execute<{ n: string }>(
        group === undefined
          ? sql`SELECT count(*) AS n FROM platform.deliveries`
          : sql`SELECT count(*) AS n FROM platform.deliveries WHERE group_name = ${group}`,
      )
      return Number(res.rows[0]!.n)
    },

    async deadLetters() {
      const res = await db.system.execute<StoredRow & { group_name: string; seq: string; attempts: number; error: string }>(sql`
        SELECT d.group_name, d.seq, d.attempts, d.error, ${STORED_E}
          FROM platform.dead_letters d JOIN platform.events e ON e.seq = d.seq ORDER BY d.id`)
      return res.rows.map((r) => ({ group: r.group_name, seq: Number(r.seq), attempts: r.attempts, error: r.error, event: storedEvent(r) }))
    },

    async retryDeadLetter(group, eventId) {
      await sync()
      if (!(await groupRow(group))) return false
      await fanOut()
      return withSystem(db, async (tx) => {
        const res = await tx.execute<{ seq: string; key: string }>(sql`
          DELETE FROM platform.dead_letters WHERE id = (
            SELECT d.id FROM platform.dead_letters d JOIN platform.events e ON e.seq = d.seq
             WHERE d.group_name = ${group} AND e.id = ${eventId} ORDER BY d.id DESC LIMIT 1)
          RETURNING seq, (SELECT key FROM platform.events WHERE seq = platform.dead_letters.seq) AS key`)
        const row = res.rows[0]
        if (!row) return false
        await tx.execute(sql`INSERT INTO platform.deliveries (group_name, seq, key) VALUES (${group}, ${row.seq}, ${row.key})`)
        return true
      })
    },

    async replay(group, fromSeq = 1) {
      await sync()
      const row = await groupRow(group)
      if (!row) throw new Error(`Unknown group ${group}`)
      await fanOut()
      const res = await db.system.execute<{ seq: string }>(sql`
        INSERT INTO platform.deliveries (group_name, seq, key)
        SELECT ${group}, e.seq, e.key FROM platform.events e
         WHERE e.seq >= ${fromSeq} AND e.fanned_out
           AND (${row.types === null ? sql`true` : sql`e.type = ANY (${toPgArray(row.types)}::text[])`})
         ORDER BY e.seq
        RETURNING seq`)
      return res.rows.length
    },

    start() {
      if (!stopped) return
      stopped = false
      const tick = () => {
        if (stopped) return
        const purging = Date.now() - lastPurge >= purgeEveryMs
        if (purging) lastPurge = Date.now()
        running = (purging ? purge().then(round) : round())
          .catch((err) => opts.onError?.(err))
          .then((r) => {
            if (!stopped) timer = setTimeout(tick, r && r.calls > 0 ? 0 : pollMs)
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
  return bus
}

type StoredRow = { id: string; type: string; key: string; data: unknown; schema_version: string | null; org_id: string; app_id: string; livemode: boolean }
const STORED = sql.raw('id, type, key, data, schema_version, org_id, app_id, livemode')
const STORED_E = sql.raw('e.id, e.type, e.key, e.data, e.schema_version, e.org_id, e.app_id, e.livemode')
const STORED_NAMED = sql.raw('e.id, e.type, e.key, e.org_id, e.app_id, e.livemode')

const storedEvent = (r: StoredRow): BusEvent => ({
  id: r.id,
  type: r.type,
  key: r.key,
  data: r.data,
  tenant: { orgId: r.org_id, appId: r.app_id, livemode: r.livemode },
  ...(r.schema_version !== null && { schemaVersion: r.schema_version }),
})

/** A Postgres array literal for a list of plain strings. */
function toPgArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
