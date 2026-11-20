// apps' answer to an erasure: it keeps nothing about the tenant's end users (its data is about the
// install's apps), so it answers nothing_held.

import { currentType, erasureAnswer, type EventData } from '@flagwise/contracts'
import type { Clock } from '@flagwise/kernel'
import { appOf, type EventBus } from '@flagwise/platform'

/** Subscribes group 'apps.erasure': subject.erasure_requested -> answers nothing_held. */
export function subscribeApps(bus: EventBus, deps: { readonly clock: Clock }): void {
  bus.subscribe('apps.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await bus.publish({ ...erasureAnswer(request, 'apps.erasure', 'nothing_held', deps.clock.now()), appRef: appOf(event) })
  })
}
