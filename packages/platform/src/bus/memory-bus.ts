// The in-memory event bus driver. It honours the contract every driver honours: at-least-once
// delivery, ordering per key, consumer groups, maxAttempts, dead-letter and replay. It runs no
// timers: work happens only inside drain(), which keeps tests deterministic.

import type { AppRef } from '@flagwise/kernel'
import type { AppTx } from '../db/database.ts'
import { stampRequest, type EventMeta } from './request-context.ts'

export interface BusEvent<T = unknown> {
  readonly id: string
  readonly type: string
  /** Ordering key, e.g. the case id. */
  readonly key: string
  readonly data: T
  /** The tenant the event belongs to. The Postgres bus requires it; the memory bus ignores it. */
  readonly appRef?: AppRef
  /** Where it came from: set at publish from the running request (see runInRequest), if any. */
  readonly meta?: EventMeta
  /**
   * The semver of the schema the data was published under. A bus with a contract sets it at
   * publish; without one it keeps what the event carries.
   */
  readonly schemaVersion?: string
  /**
   * Tracked: when it is queued, the bus publishes `bus.event_fanned_out` naming every group it was
   * queued for, and `bus.delivery_dead_lettered` when one of those deliveries is dead-lettered, so
   * the publisher can wait for an answer from each group, wherever it runs.
   */
  readonly track?: boolean
}

/** The bus's own facts about a tracked event, published with the event's tenant and key. */
export const BUS_FANNED_OUT = 'bus.event_fanned_out.v1'
export const BUS_DEAD_LETTERED = 'bus.delivery_dead_lettered.v1'

/** `bus.event_fanned_out` for a tracked event queued for `groups`. */
export function fannedOutEvent(event: BusEvent, groups: readonly string[]): BusEvent {
  return {
    id: `bus.event_fanned_out:${event.id}`,
    type: BUS_FANNED_OUT,
    key: event.key,
    data: { eventId: event.id, type: event.type, groups: [...groups].sort() },
    ...(event.appRef && { appRef: event.appRef }),
  }
}

/** `bus.delivery_dead_lettered` for a tracked event's delivery to `group`; `n` tells dead letters apart. */
export function deadLetteredEvent(event: BusEvent, group: string, attempts: number, error: string, n: number | string): BusEvent {
  return {
    id: `bus.delivery_dead_lettered:${event.id}:${group}:${n}`,
    type: BUS_DEAD_LETTERED,
    key: event.key,
    data: { eventId: event.id, type: event.type, group, attempts, error: error.slice(0, 500) },
    ...(event.appRef && { appRef: event.appRef }),
  }
}

/**
 * The event types a bus may publish and the schema of each. The bus calls it on every event it is
 * given, with the data as consumers receive it (through JSON), before it publishes any of them.
 */
export interface EventContract {
  /** The schema version `type` is published under; throws when the type is unknown or the data breaks its schema. */
  versionOf(type: string, data: unknown): string
  /** Whether `type` is in the contract; subscribing to one that is not throws. */
  knows(type: string): boolean
}

/** Throws when a group subscribes to a type its bus's contract does not know, so a misspelled type fails at boot. */
export function checkSubscription(group: string, types: readonly string[] | '*', contract: EventContract | undefined): void {
  if (!contract || types === '*') return
  const unknown = types.filter((t) => !contract.knows(t))
  if (unknown.length > 0) throw new TypeError(`Group ${group} subscribes to ${unknown.join(', ')}, not in the event contract`)
}

/** An event as consumers receive it: its data through JSON, its schema version from the contract when there is one. */
export function checkedEvent(event: BusEvent, contract: EventContract | undefined): BusEvent {
  if (!contract) return event
  const data = event.data === undefined ? null : JSON.parse(JSON.stringify(event.data))
  return { ...event, schemaVersion: contract.versionOf(event.type, data) }
}

export interface DeliveryContext {
  readonly group: string
  readonly seq: number
  readonly attempt: number
}

export type Handler = (event: BusEvent, ctx: DeliveryContext) => void | Promise<void>

export interface DeadLetter {
  readonly group: string
  readonly seq: number
  readonly event: BusEvent
  readonly attempts: number
  readonly error: string
}

export interface SubscribeOptions {
  /** Attempts per delivery for this group; integer >= 1, default the bus's. */
  readonly maxAttempts?: number
  /**
   * Delay before attempt `attempt + 1` after attempt `attempt` failed, for this group; default the
   * bus's. The memory bus runs no timers and ignores it.
   */
  readonly retryDelayMs?: (attempt: number) => number
}

/** What code that publishes and handles events needs, whatever the driver. */
export interface EventBus {
  /**
   * Publishes events; returns how many were new. With `tx`, the Postgres bus writes them in that
   * transaction, so they exist only if it commits; the memory bus ignores `tx`.
   */
  publish(events: BusEvent | readonly BusEvent[], tx?: AppTx): Promise<number>
  subscribe(group: string, types: readonly string[] | '*', handler: Handler, opts?: SubscribeOptions): () => void
  /** Delivers until nothing is ready; returns how many handler calls it made. */
  drain(): Promise<number>
}

export interface MemoryBus extends EventBus {
  log(): readonly { readonly seq: number; readonly event: BusEvent }[]
  pending(group?: string): number
  deadLetters(): readonly DeadLetter[]
  retryDeadLetter(group: string, eventId: string): boolean
  replay(group: string, fromSeq?: number): number
}

/**
 * Creates a bus; `maxAttempts` (default 5) must be an integer >= 1, else RangeError. With a
 * `contract`, every event is checked against it at publish and gets its schema version; one that
 * fails throws and nothing from that call is published.
 *
 * Publishing: `publish` appends each new event to the log with the next sequence number and queues
 * one delivery per subscribed group whose types match (`'*'` matches all). It runs no handler. A
 * tracked event is followed by its `bus.event_fanned_out`, and a dead letter of one by
 * `bus.delivery_dead_lettered` (see BusEvent.track). An
 * event id already in the log is ignored. Every event needs non-empty string id, type and key, else
 * TypeError and nothing from that call is published. Returns how many events were new.
 *
 * Subscribing: one handler per consumer group; types is a non-empty array or '*'; a group name
 * already subscribed throws. A new group only receives later events (see replay). The returned
 * function unsubscribes: the group and its queued deliveries are dropped, its dead letters stay.
 *
 * Delivering: `drain()` delivers until nothing is queued and returns how many handler calls it
 * made. Within a group, deliveries with the same key run strictly in sequence order, one at a time:
 * a failing delivery stays at the head of its key and blocks later events with that key, in that
 * group only, until it succeeds or is dead-lettered. drain() works in rounds; in each round, for
 * every group in subscription order and every key in the order of its head's sequence number, the
 * handler is called once for that head, with `{ group, seq, attempt }` (attempt from 1). Throwing or
 * rejecting is a failure; when attempt reaches the group's maxAttempts the delivery moves to the
 * dead letters as `{ group, seq, event, attempts, error }` (the Error's message, or String() of
 * what was thrown), else it is retried next round. Events published by a handler are delivered in
 * the same drain().
 *
 * Inspecting and repairing: `log()`, `pending(group?)`, `deadLetters()` (in dead-letter order);
 * `retryDeadLetter(group, eventId)` queues a dead letter again from attempt 1, behind what is already
 * queued for its key (false when there is no such dead letter or the group is gone);
 * `replay(group, fromSeq = 1)` queues again every logged event from `fromSeq` that the group
 * subscribed to, for rebuilding projections (consumers must be idempotent), and returns the count;
 * an unknown group throws.
 */
export function createMemoryBus(opts?: { maxAttempts?: number; contract?: EventContract }): MemoryBus {
  const defaultMaxAttempts = checkMaxAttempts(opts?.maxAttempts ?? 5)
  const entries: { seq: number; event: BusEvent }[] = []
  const ids = new Set<string>()
  const groups = new Map<string, Group>()
  const dead: DeadLetter[] = []

  const enqueue = (group: Group, seq: number, event: BusEvent) => {
    if (group.types === '*' || group.types.includes(event.type)) {
      group.queue.push({ seq, event, attempt: 1 })
      return true
    }
    return false
  }

  /** Logs and queues new events; a tracked one is followed by its bus.event_fanned_out. */
  const append = async (checked: readonly BusEvent[]): Promise<number> => {
    let added = 0
    for (const published of checked) {
      const event = stampRequest(published)
      if (ids.has(event.id)) continue
      ids.add(event.id)
      const seq = entries.length + 1
      entries.push({ seq, event })
      const queued = [...groups.values()].filter((group) => enqueue(group, seq, event)).map((g) => g.name)
      added++
      if (event.track) await append([checkedEvent(fannedOutEvent(event, queued), opts?.contract)])
    }
    return added
  }

  const deliverRound = async (group: Group): Promise<number> => {
    const heads = new Map<string, Delivery>()
    for (const d of group.queue) if (!heads.has(d.event.key)) heads.set(d.event.key, d)
    const ordered = [...heads.values()].sort((a, b) => a.seq - b.seq)
    let calls = 0
    for (const d of ordered) {
      if (groups.get(group.name) !== group) break
      calls++
      try {
        await group.handler(d.event, { group: group.name, seq: d.seq, attempt: d.attempt })
        removeFrom(group.queue, d)
      } catch (err) {
        if (d.attempt >= group.maxAttempts) {
          removeFrom(group.queue, d)
          const error = err instanceof Error ? err.message : String(err)
          dead.push({ group: group.name, seq: d.seq, event: d.event, attempts: d.attempt, error })
          if (d.event.track) await append([checkedEvent(deadLetteredEvent(d.event, group.name, d.attempt, error, dead.length), opts?.contract)])
        } else {
          d.attempt++
        }
      }
    }
    return calls
  }

  return {
    async publish(input) {
      const events = Array.isArray(input) ? (input as readonly BusEvent[]) : [input as BusEvent]
      for (const e of events) {
        if (!e || !isNonEmpty(e.id) || !isNonEmpty(e.type) || !isNonEmpty(e.key)) {
          throw new TypeError('an event needs a non-empty string id, type and key')
        }
      }
      return append(events.map((e) => checkedEvent(e, opts?.contract)))
    },

    subscribe(name, types, handler, subOpts) {
      if (groups.has(name)) throw new Error(`group already subscribed: ${name}`)
      if (types !== '*' && (!Array.isArray(types) || types.length === 0)) {
        throw new TypeError("types must be a non-empty array or '*'")
      }
      checkSubscription(name, types, opts?.contract)
      const group: Group = {
        name,
        types,
        handler,
        maxAttempts: subOpts?.maxAttempts === undefined ? defaultMaxAttempts : checkMaxAttempts(subOpts.maxAttempts),
        queue: [],
      }
      groups.set(name, group)
      return () => {
        if (groups.get(name) === group) groups.delete(name)
      }
    },

    async drain() {
      let calls = 0
      for (;;) {
        let progressed = false
        for (const group of [...groups.values()]) {
          if (groups.get(group.name) !== group || group.queue.length === 0) continue
          calls += await deliverRound(group)
          progressed = true
        }
        if (!progressed) return calls
      }
    },

    log: () => entries.map((e) => ({ seq: e.seq, event: e.event })),

    pending(name) {
      if (name !== undefined) return groups.get(name)?.queue.length ?? 0
      let total = 0
      for (const group of groups.values()) total += group.queue.length
      return total
    },

    deadLetters: () => [...dead],

    retryDeadLetter(name, eventId) {
      const group = groups.get(name)
      if (!group) return false
      const index = dead.findIndex((d) => d.group === name && d.event.id === eventId)
      if (index < 0) return false
      const [letter] = dead.splice(index, 1)
      group.queue.push({ seq: letter!.seq, event: letter!.event, attempt: 1 })
      return true
    },

    replay(name, fromSeq = 1) {
      const group = groups.get(name)
      if (!group) throw new Error(`unknown group: ${name}`)
      let count = 0
      for (const e of entries) if (e.seq >= fromSeq && enqueue(group, e.seq, e.event)) count++
      return count
    },
  }
}

interface Delivery {
  readonly seq: number
  readonly event: BusEvent
  attempt: number
}

interface Group {
  readonly name: string
  readonly types: readonly string[] | '*'
  readonly handler: Handler
  readonly maxAttempts: number
  readonly queue: Delivery[]
}

function checkMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('maxAttempts must be an integer >= 1')
  return value
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function removeFrom(queue: Delivery[], d: Delivery): void {
  const i = queue.indexOf(d)
  if (i >= 0) queue.splice(i, 1)
}
