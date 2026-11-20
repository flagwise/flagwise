// The install's apps: creating one, deleting it (kept for the grace period, while it can be
// restored) and restoring it. Each change is published as a fact; what other services need of an
// app they keep from those facts.

import { FlagwiseError, type Clock } from '@flagwise/kernel'
import { canRestore, deletionStatus } from '../domain/lifecycle.ts'

export interface App {
  readonly id: string
  readonly name: string
  readonly createdAt: Date
  readonly deletedAt: Date | null
}

/** The registry inside one app transaction: every method sees only its apps. */
export interface AppStore {
  insertApp(app: App): Promise<void>
  findApp(appId: string): Promise<App | null>
  setDeletedAt(appId: string, deletedAt: Date | null): Promise<void>
}

/** What apps publishes when an app changes. */
export type AppEvent =
  | { readonly type: 'app.created'; readonly appId: string; readonly name: string; readonly occurredAt: Date }
  | { readonly type: 'app.deletion_requested'; readonly appId: string; readonly purgeAt: Date; readonly occurredAt: Date }
  | { readonly type: 'app.restored'; readonly appId: string; readonly occurredAt: Date }

export interface AppEventPublisher {
  /** Publishes in the same transaction as the change. */
  publish(event: AppEvent): Promise<void>
}

export interface AppDeps {
  readonly store: AppStore
  readonly clock: Clock
  readonly newAppId: () => string
  /** Where app changes are published; left out, nothing is. */
  readonly events?: AppEventPublisher
}

/** Creates an app, with the given id or a new one. 'invalid_request' for an empty name. */
export async function createApp(deps: AppDeps, input: { readonly id?: string; readonly name: string }): Promise<App> {
  const name = input.name.trim()
  if (!name) throw new FlagwiseError('invalid_request', 'An app needs a name')
  const app: App = { id: input.id ?? deps.newAppId(), name, createdAt: deps.clock.now(), deletedAt: null }
  await deps.store.insertApp(app)
  await deps.events?.publish({ type: 'app.created', appId: app.id, name: app.name, occurredAt: app.createdAt })
  return app
}

/** Deletes an app: it can be restored until the grace period ends. Deleting a deleted app changes nothing. */
export async function deleteApp(deps: AppDeps, appId: string): Promise<App> {
  const app = await found(deps, appId)
  if (app.deletedAt) return app
  const now = deps.clock.now()
  await deps.store.setDeletedAt(appId, now)
  const deleted = { ...app, deletedAt: now }
  await deps.events?.publish({ type: 'app.deletion_requested', appId, purgeAt: deletionStatus({ deletedAt: now, purgedAt: null }, now).purgeAt!, occurredAt: now })
  return deleted
}

/** Restores a deleted app within the grace period ('gone' after it); restoring an active app changes nothing. */
export async function restoreApp(deps: AppDeps, appId: string): Promise<App> {
  const app = await found(deps, appId)
  if (!app.deletedAt) return app
  const now = deps.clock.now()
  if (!canRestore({ deletedAt: app.deletedAt, purgedAt: null }, now)) throw new FlagwiseError('gone', `App ${appId} is past its grace period`)
  await deps.store.setDeletedAt(appId, null)
  await deps.events?.publish({ type: 'app.restored', appId, occurredAt: now })
  return { ...app, deletedAt: null }
}

async function found(deps: AppDeps, appId: string): Promise<App> {
  const app = await deps.store.findApp(appId)
  if (!app) throw new FlagwiseError('not_found', `No app ${appId}`)
  return app
}
