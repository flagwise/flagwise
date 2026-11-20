// auth's handlers: its copy of the apps, kept from the apps service's facts, and its answer to an
// erasure (it keeps nothing about the tenant's end users, so it answers nothing_held).

import { currentType, erasureAnswer, type EventData } from '@flagwise/contracts'
import type { Clock } from '@flagwise/kernel'
import { appOf, type EventBus } from '@flagwise/platform'
import type { AppCopies } from './keys.ts'

export interface AuthHandlerDeps {
  readonly apps: AppCopies
  readonly clock: Clock
}

/**
 * Subscribes group 'auth.apps': app.created, app.deletion_requested and app.restored -> auth's copy
 * of the app (one group, so they arrive in the order they were published); and group
 * 'auth.erasure': subject.erasure_requested -> answers nothing_held.
 */
export function subscribeAuth(bus: EventBus, deps: AuthHandlerDeps): void {
  bus.subscribe('auth.apps', [currentType('app.created'), currentType('app.deletion_requested'), currentType('app.restored')], async (event) => {
    const { appId } = appOf(event)
    if (event.type === currentType('app.created')) await deps.apps.created(appId)
    else if (event.type === currentType('app.deletion_requested')) {
      await deps.apps.setDeletedAt(appId, new Date((event.data as EventData<'app.deletion_requested.v1'>).occurredAt))
    } else await deps.apps.setDeletedAt(appId, null)
  })
  bus.subscribe('auth.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await bus.publish({ ...erasureAnswer(request, 'auth.erasure', 'nothing_held', deps.clock.now()), appRef: appOf(event) })
  })
}
