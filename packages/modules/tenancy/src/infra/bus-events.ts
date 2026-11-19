// Tenancy's events on the event bus, written in the transaction of the change.

import { currentType } from '@flagwise/contracts'
import type { BusEvent, EventBus, AppTx } from '@flagwise/platform'
import type { TenancyEvent, TenancyEventPublisher } from '../app/registry.ts'

/** Publishes tenancy's events in `tx`, keyed by the key they are about. */
export function busTenancyEvents(bus: EventBus, tx: AppTx, newEventId: () => string): TenancyEventPublisher {
  return {
    async publish(event: TenancyEvent) {
      const { type, appRef, ...data } = event
      const busEvent: BusEvent = { id: newEventId(), type: currentType(type), key: event.keyId, data, appRef }
      await bus.publish(busEvent, tx)
    },
  }
}
