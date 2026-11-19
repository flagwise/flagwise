// A unit of work runs one piece of a service's work for one tenant: the service's stores and the
// events it publishes share one transaction, so the events exist exactly when the change does. A
// unit of work holds the stores of one service only; services never share a transaction.

import type { AppRef } from '@flagwise/kernel'
import { scopeOfApp, withApps, type Database, type AppTx } from '../db/database.ts'
import type { BusEvent, EventBus } from './memory-bus.ts'

export interface Work<S> {
  readonly stores: S
  /** Publishes in the work's transaction; every event gets the work's tenant. */
  publish(events: BusEvent | readonly BusEvent[]): Promise<void>
}

export interface UnitOfWork<S> {
  run<R>(appRef: AppRef, fn: (work: Work<S>) => Promise<R>): Promise<R>
}

const withAppRef = (events: BusEvent | readonly BusEvent[], appRef: AppRef): BusEvent[] =>
  (Array.isArray(events) ? events : [events as BusEvent]).map((e) => ({ ...e, appRef }))

/**
 * On Postgres: each run is one app transaction with the stores `storesOf` builds on it, and
 * events are written to the bus log in it. A run that throws is rolled back, events included.
 */
export function pgUnitOfWork<S>(db: Database, bus: EventBus, storesOf: (tx: AppTx) => S): UnitOfWork<S> {
  return {
    run: (appRef, fn) =>
      withApps(db, scopeOfApp(appRef), (tx) =>
        fn({
          stores: storesOf(tx),
          publish: async (events) => {
            await bus.publish(withAppRef(events, appRef), tx)
          },
        }),
      ),
  }
}

/**
 * In memory, for tests and dev: the given stores, and events held back until the run returns, so
 * a run that throws publishes nothing. Store writes are not rolled back.
 */
export function memoryUnitOfWork<S>(bus: EventBus, stores: S): UnitOfWork<S> {
  return {
    async run(appRef, fn) {
      const held: BusEvent[] = []
      const result = await fn({
        stores,
        publish: async (events) => {
          held.push(...withAppRef(events, appRef))
        },
      })
      if (held.length) await bus.publish(held)
      return result
    },
  }
}

/** The tenant of a delivered event: the bus stores it with every event. */
export function appOf(event: BusEvent): AppRef {
  if (!event.appRef) throw new Error(`Event ${event.id} has no appRef`)
  return event.appRef
}
