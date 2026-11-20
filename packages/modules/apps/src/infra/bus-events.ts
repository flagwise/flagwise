// The apps service's events on the event bus, written in the transaction of the change.

import { currentType } from '@flagwise/contracts'
import type { AppTx, BusEvent, EventBus } from '@flagwise/platform'
import type { AppEvent, AppEventPublisher } from '../app/registry.ts'

/**
 * Publishes app facts in `tx`, keyed by the app. An app has no mode, so its facts are written in
 * live mode and hold for both.
 */
export function busAppEvents(bus: EventBus, tx: AppTx, newEventId: () => string): AppEventPublisher {
  return {
    async publish(event: AppEvent) {
      const { type, ...data } = event
      const busEvent: BusEvent = { id: newEventId(), type: currentType(type), key: event.appId, data, appRef: { appId: event.appId, livemode: true } }
      await bus.publish(busEvent, tx)
    },
  }
}
