// Tenancy's events on the event bus, written in the transaction of the change.

import { currentType } from '@flagwise/contracts'
import type { BusEvent, EventBus, TenantTx } from '@flagwise/platform'
import type { TenancyEvent, TenancyEventPublisher } from '../app/registry.ts'

/** Publishes tenancy's events in `tx`, keyed by the key they are about. */
export function busTenancyEvents(bus: EventBus, tx: TenantTx, newEventId: () => string): TenancyEventPublisher {
  return {
    async publish(event: TenancyEvent) {
      const { type, tenant, ...data } = event
      const busEvent: BusEvent = { id: newEventId(), type: currentType(type), key: event.keyId, data, tenant }
      await bus.publish(busEvent, tx)
    },
  }
}
