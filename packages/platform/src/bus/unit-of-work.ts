// A unit of work runs one piece of a service's work for one tenant: the service's stores and the
// events it publishes share one transaction, so the events exist exactly when the change does. A
// unit of work holds the stores of one service only; services never share a transaction.

import type { TenantRef } from '@flagwise/kernel'
import { scopeOfRef, withTenant, type Database, type TenantTx } from '../db/tenant.ts'
import type { BusEvent, EventBus } from './memory-bus.ts'

export interface Work<S> {
  readonly stores: S
  /** Publishes in the work's transaction; every event gets the work's tenant. */
  publish(events: BusEvent | readonly BusEvent[]): Promise<void>
}

export interface UnitOfWork<S> {
  run<R>(tenant: TenantRef, fn: (work: Work<S>) => Promise<R>): Promise<R>
}

const withTenantRef = (events: BusEvent | readonly BusEvent[], tenant: TenantRef): BusEvent[] =>
  (Array.isArray(events) ? events : [events as BusEvent]).map((e) => ({ ...e, tenant }))

/**
 * On Postgres: each run is one tenant transaction with the stores `storesOf` builds on it, and
 * events are written to the bus log in it. A run that throws is rolled back, events included.
 */
export function pgUnitOfWork<S>(db: Database, bus: EventBus, storesOf: (tx: TenantTx) => S): UnitOfWork<S> {
  return {
    run: (tenant, fn) =>
      withTenant(db, scopeOfRef(tenant), (tx) =>
        fn({
          stores: storesOf(tx),
          publish: async (events) => {
            await bus.publish(withTenantRef(events, tenant), tx)
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
    async run(tenant, fn) {
      const held: BusEvent[] = []
      const result = await fn({
        stores,
        publish: async (events) => {
          held.push(...withTenantRef(events, tenant))
        },
      })
      if (held.length) await bus.publish(held)
      return result
    },
  }
}

/** The tenant of a delivered event: the bus stores it with every event. */
export function tenantOf(event: BusEvent): TenantRef {
  if (!event.tenant) throw new Error(`Event ${event.id} has no tenant`)
  return event.tenant
}
