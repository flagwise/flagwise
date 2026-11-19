// The policy's events on the event bus, written in the transaction of the change.

import { currentType } from '@flagwise/contracts'
import type { BusEvent, EventBus, AppTx } from '@flagwise/platform'
import type { PolicyEvent, PolicyEventPublisher } from '../app/ports.ts'

/** Publishes the policy's events in `tx`: policy.updated keyed `policy:{appId}`, what each change was keyed `config:{appId}`. */
export function busPolicyEvents(bus: EventBus, tx: AppTx, newEventId: () => string): PolicyEventPublisher {
  return {
    async publish(event: PolicyEvent) {
      const { type, appRef, ...data } = event
      const key = type === 'policy.updated' ? `policy:${event.appId}` : `config:${event.appId}`
      const busEvent: BusEvent = { id: newEventId(), type: currentType(type), key, data, appRef }
      await bus.publish(busEvent, tx)
    },
  }
}
