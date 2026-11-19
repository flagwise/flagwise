// The audit log on the bus: every catalogued major of every recorded fact, each appended to its app and mode's
// chain on its own, under the fact's name. A redelivered event is recognised by its id and not
// appended again.

import { EVENT_CATALOG, factOf } from '@flagwise/contracts'
import type { Clock, TenantRef } from '@flagwise/kernel'
import { tenantOf, type EventBus } from '@flagwise/platform'
import type { AuditRoutesDeps } from '../api/routes.ts'
import { AUDITED_EVENT_TYPES } from '../domain/events.ts'
import { recordEvent, verifyAuditLog, type AuditStore } from './audit-log.ts'

export interface AuditServiceDeps {
  /** Runs `fn` in one transaction of the tenant. */
  run<R>(tenant: TenantRef, fn: (store: AuditStore) => Promise<R>): Promise<R>
  readonly clock: Clock
}

/**
 * Subscribes group 'audit.log' to every catalogued major of every audited fact -> recordEvent, with
 * the fact's name as the type: the fields it records are named the same in each major.
 */
export function subscribeAudit(bus: EventBus, deps: AuditServiceDeps): void {
  const types = Object.entries(EVENT_CATALOG)
    .filter(([, spec]) => AUDITED_EVENT_TYPES.includes(spec.name))
    .map(([type]) => type)
  bus.subscribe('audit.log', types, async (event) => {
    const tenant = tenantOf(event)
    const recorded = { ...event, type: factOf(event.type)?.name ?? event.type }
    await deps.run(tenant, (store) => recordEvent({ store, clock: deps.clock }, tenant, recorded))
  })
}

/** What the audit routes read, each in one transaction of the tenant. */
export function auditReads(deps: Pick<AuditServiceDeps, 'run'>): AuditRoutesDeps {
  return {
    search: (tenant, query) => deps.run(tenant, (store) => store.search(tenant, query)),
    verify: (tenant) => deps.run(tenant, (store) => verifyAuditLog({ store }, tenant)),
  }
}
