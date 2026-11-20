// Auth's events on the event bus, written in the transaction of the change.

import { currentType } from '@flagwise/contracts'
import type { AppTx, BusEvent, EventBus } from '@flagwise/platform'
import type { KeyEvent, KeyEventPublisher } from '../app/keys.ts'

/** Publishes auth's events in `tx`, keyed by the key they are about. */
export function busKeyEvents(bus: EventBus, tx: AppTx, newEventId: () => string): KeyEventPublisher {
  return {
    async publish(event: KeyEvent) {
      const { type, appRef, ...data } = event
      const busEvent: BusEvent = { id: newEventId(), type: currentType(type), key: event.keyId, data, appRef }
      await bus.publish(busEvent, tx)
    },
  }
}
