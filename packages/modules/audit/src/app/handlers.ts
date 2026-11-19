// The audit log on the bus: every catalogued major of every recorded fact, each appended to its app and mode's
// chain on its own, under the fact's name. A redelivered event is recognised by its id and not
// appended again.

import { currentType, erasedId, erasureAnswer, EVENT_CATALOG, factOf, type EventData } from '@flagwise/contracts'
import type { Clock, AppRef } from '@flagwise/kernel'
import { appOf, type EventBus } from '@flagwise/platform'
import type { AuditRoutesDeps } from '../api/routes.ts'
import { AUDITED_EVENT_TYPES } from '../domain/events.ts'
import { recordEvent, verifyAuditLog, type AuditStore } from './audit-log.ts'

export interface AuditServiceDeps {
  /** Runs `fn` in one transaction of the app. */
  run<R>(appRef: AppRef, fn: (store: AuditStore) => Promise<R>): Promise<R>
  readonly clock: Clock
}

/**
 * Subscribes audit's groups:
 * - 'audit.log': every catalogued major of every audited fact -> recordEvent, with the fact's name
 *   as the type: the fields it records are named the same in each major.
 * - 'audit.erasure': subject.erasure_requested -> the account erased from the entries found by it;
 *   answers erased, or nothing_held.
 */
export function subscribeAudit(bus: EventBus, deps: AuditServiceDeps): void {
  const types = Object.entries(EVENT_CATALOG)
    .filter(([, spec]) => AUDITED_EVENT_TYPES.includes(spec.name))
    .map(([type]) => type)
  bus.subscribe('audit.log', types, async (event) => {
    const appRef = appOf(event)
    const recorded = { ...event, type: factOf(event.type)?.name ?? event.type }
    await deps.run(appRef, (store) => recordEvent({ store, clock: deps.clock }, appRef, recorded))
  })
  bus.subscribe('audit.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const appRef = appOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    const had = await deps.run(appRef, (store) => store.eraseAccount(appRef, request.subjectExternalId, erasedId(request.erasureId)))
    // Published after the erase commits; should it be lost, the redelivery finds nothing left and answers nothing_held.
    await bus.publish({ ...erasureAnswer(request, 'audit.erasure', had > 0 ? 'erased' : 'nothing_held', deps.clock.now()), appRef })
  })
}

/** What the audit routes read, each in one transaction of the app. */
export function auditReads(deps: Pick<AuditServiceDeps, 'run'>): AuditRoutesDeps {
  return {
    search: (appRef, query) => deps.run(appRef, (store) => store.search(appRef, query)),
    verify: (appRef) => deps.run(appRef, (store) => verifyAuditLog({ store }, appRef)),
  }
}
