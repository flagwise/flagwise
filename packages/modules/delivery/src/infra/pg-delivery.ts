// Delivery on Postgres: its handlers and settlements on its own tables, each run in an app
// transaction of its own, the read side of its routes, and the webhook sender's deps.

import type { AppRef } from '@flagwise/kernel'
import { pgUnitOfWork, scopeOfApp, withSystem, withApps, type Database, type EventBus } from '@flagwise/platform'
import type { ActionRequestStore } from '../app/action-requests.ts'
import type { SenderDeps } from '../app/send-webhooks.ts'
import type { DeliveryServiceDeps } from '../app/service.ts'
import { pgActionRequestStore } from './pg-action-request-store.ts'
import { pgWebhookOutbox, pgWebhookStore } from './pg-webhook-store.ts'

export function pgDeliveryDeps(db: Database, bus: EventBus, options: Omit<DeliveryServiceDeps, 'uow'>): DeliveryServiceDeps {
  return { ...options, uow: pgUnitOfWork(db, bus, (tx) => ({ requests: pgActionRequestStore(tx), webhooks: pgWebhookStore(tx) })) }
}

/** Runs `fn` with the action request store in an app transaction. */
export function pgActionRequestReads(db: Database): <T>(appRef: AppRef, fn: (requests: ActionRequestStore) => Promise<T>) => Promise<T> {
  return (appRef, fn) => withApps(db, scopeOfApp(appRef), (tx) => fn(pgActionRequestStore(tx)))
}

/** The webhook sender's outbox (through the system role) and app-scoped stores. */
export function pgSenderDeps(db: Database, options: Omit<SenderDeps, 'outbox' | 'inApp'>): SenderDeps {
  return {
    ...options,
    outbox: { leaseDue: (now, o) => withSystem(db, (tx) => pgWebhookOutbox(tx).leaseDue(now, o)) },
    inApp: (appRef, fn) => withApps(db, scopeOfApp(appRef), (tx) => fn(pgWebhookStore(tx))),
  }
}
