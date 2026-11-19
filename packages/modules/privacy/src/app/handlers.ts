// Privacy as a service: starting an erasure, reading it, and following it on the bus, each in one
// transaction of its own.

import { currentType, type EventData } from '@flagwise/contracts'
import type { Clock, TenantRef } from '@flagwise/kernel'
import { tenantOf, type EventBus, type UnitOfWork } from '@flagwise/platform'
import { applyNews, startErasure, type ErasureRecord, type PrivacyStores } from './erasure.ts'

export interface PrivacyServiceDeps {
  readonly uow: UnitOfWork<PrivacyStores>
  readonly clock: Clock
  readonly newErasureId: () => string
}

export interface PrivacyService {
  erase(tenant: TenantRef, subjectExternalId: string): Promise<{ erasure: ErasureRecord; created: boolean }>
  find(tenant: TenantRef, erasureId: string): Promise<ErasureRecord | null>
}

export function privacyService(deps: PrivacyServiceDeps): PrivacyService {
  return {
    erase: (tenant, subjectExternalId) => deps.uow.run(tenant, (w) => startErasure(deps, w, { tenant, subjectExternalId })),
    find: (tenant, erasureId) => deps.uow.run(tenant, (w) => w.stores.erasures.find(tenant, erasureId)),
  }
}

const REQUESTED = currentType('subject.erasure_requested')

/**
 * Subscribes group 'privacy.erasures' to what it hears about erasures, all keyed by the erasure:
 * bus.event_fanned_out of a subject.erasure_requested (the groups to wait for),
 * bus.delivery_dead_lettered of one (that group failed and is still waited for), and
 * subject.erased (a group's answer) -> applyNews.
 */
export function subscribePrivacy(bus: EventBus, deps: PrivacyServiceDeps): void {
  bus.subscribe('privacy.erasures', [currentType('bus.event_fanned_out'), currentType('bus.delivery_dead_lettered'), currentType('subject.erased')], async (event) => {
    const tenant = tenantOf(event)
    if (event.type === currentType('subject.erased')) {
      const a = event.data as EventData<'subject.erased.v1'>
      await deps.uow.run(tenant, (w) => applyNews(deps, w, tenant, a.erasureId, { kind: 'answered', group: a.group, status: a.status, heldItems: a.heldItems, reason: a.reason }))
      return
    }
    if (event.type === currentType('bus.event_fanned_out')) {
      const f = event.data as EventData<'bus.event_fanned_out.v1'>
      if (f.type !== REQUESTED) return
      await deps.uow.run(tenant, (w) => applyNews(deps, w, tenant, event.key, { kind: 'reached', groups: f.groups }))
      return
    }
    const d = event.data as EventData<'bus.delivery_dead_lettered.v1'>
    if (d.type !== REQUESTED) return
    await deps.uow.run(tenant, (w) => applyNews(deps, w, tenant, event.key, { kind: 'dead_lettered', group: d.group, error: d.error }))
  })
}
