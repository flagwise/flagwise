// Notifications as a service: it keeps the notifications the other services raise and clear on
// the bus, and lets people list and acknowledge them, each in one transaction of its own. It
// knows only notification facts, never the facts behind them.

import { currentType, erasureAnswer, type EventData } from '@flagwise/contracts'
import { FlagwiseError, type AppRef, type Clock } from '@flagwise/kernel'
import { appOf, type EventBus, type UnitOfWork } from '@flagwise/platform'
import { acknowledged, cleared, isNotificationType, raised, type NotificationRecord, type NotificationState } from '../domain/lifecycle.ts'

/** Every method only sees notifications of the given app and mode. */
export interface NotificationStore {
  findByKey(appRef: AppRef, key: string): Promise<NotificationRecord | null>
  findById(appRef: AppRef, id: string): Promise<NotificationRecord | null>
  /** Until the current transaction ends, another caller locking the same key waits. */
  lockKey(appRef: AppRef, key: string): Promise<void>
  /** Inserts it, or replaces the one with its key. */
  save(record: NotificationRecord): Promise<void>
  /** The raised ones in the given states, most recently raised first, at most `limit`. */
  list(appRef: AppRef, states: readonly NotificationState[], limit: number): Promise<readonly NotificationRecord[]>
}

export interface NotificationStores {
  readonly notifications: NotificationStore
}

export interface NotificationsServiceDeps {
  readonly uow: UnitOfWork<NotificationStores>
  readonly clock: Clock
  readonly newNotificationId: () => string
}

export interface NotificationsService {
  list(appRef: AppRef, states: readonly NotificationState[], limit: number): Promise<readonly NotificationRecord[]>
  /** Acknowledges it and returns it; 'not_found' for an unknown id. */
  acknowledge(appRef: AppRef, id: string): Promise<NotificationRecord>
}

export function notificationsService(deps: NotificationsServiceDeps): NotificationsService {
  return {
    list: (appRef, states, limit) => deps.uow.run(appRef, (w) => w.stores.notifications.list(appRef, states, limit)),
    acknowledge: (appRef, id) =>
      deps.uow.run(appRef, async (w) => {
        const store = w.stores.notifications
        const seen = await store.findById(appRef, id)
        if (!seen) throw new FlagwiseError('not_found', 'No such notification')
        // Locked like the raises and clears of its key, so a clear meanwhile is not lost.
        await store.lockKey(appRef, seen.key)
        const found = (await store.findById(appRef, id))!
        const next = acknowledged(found, deps.clock.now())
        if (!next) return found
        await store.save(next)
        return next
      }),
  }
}

/**
 * Subscribes notifications' groups (event -> effect):
 * - 'notifications': notification.raised -> opens it, unless it is open already or its clear came
 *   first; notification.cleared -> resolves it. Both keyed by the notification, so a raise and
 *   its clear arrive in order. Types it does not know are ignored.
 * - 'notifications.erasure': subject.erasure_requested -> nothing_held: notifications name cases
 *   and action requests, never accounts.
 */
export function subscribeNotifications(bus: EventBus, deps: NotificationsServiceDeps): void {
  bus.subscribe('notifications', [currentType('notification.raised'), currentType('notification.cleared')], async (event) => {
    const appRef = appOf(event)
    const d = event.data as EventData<'notification.raised.v1'> | EventData<'notification.cleared.v1'>
    if (!isNotificationType(d.type)) return
    const type = d.type
    await deps.uow.run(appRef, async (w) => {
      const store = w.stores.notifications
      await store.lockKey(appRef, d.key)
      const existing = await store.findByKey(appRef, d.key)
      const next =
        'values' in d
          ? raised(existing, { appRef, key: d.key, type, values: d.values, at: new Date(d.occurredAt) }, deps.newNotificationId)
          : cleared(existing, { appRef, key: d.key, type, fact: d.fact, at: new Date(d.occurredAt) }, deps.newNotificationId)
      if (next) await store.save(next)
    })
  })

  bus.subscribe('notifications.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await deps.uow.run(appOf(event), (w) => w.publish(erasureAnswer(request, 'notifications.erasure', 'nothing_held', deps.clock.now())))
  })
}
