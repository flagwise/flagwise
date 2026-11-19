// The request an event comes from. The API edge runs each authenticated request inside
// runInRequest; the buses stamp what it holds on every event published during it, so the audit log
// knows who caused an event and in which request without every use case passing it along.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ActorRef {
  /** `api_key`, `member`, `operator` (the CLI) or `system`. */
  readonly type: string
  readonly id: string
}

export interface RequestContext {
  readonly requestId?: string
  readonly actor?: ActorRef
}

/** Where an event came from; on a delivered event, also when it was published (Postgres bus). */
export interface EventMeta extends RequestContext {
  readonly publishedAt?: Date
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Runs `fn` as part of the request: events published inside it carry the request's id and actor. */
export function runInRequest<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** The request the current code runs in, if any. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore()
}

/**
 * The event with the current request's id and actor as its meta, unless it has meta already or no
 * request is running (then it is returned unchanged).
 */
export function stampRequest<E extends { readonly id: string; readonly meta?: EventMeta }>(event: E): E {
  const context = storage.getStore()
  if (event.meta || !context || (!context.requestId && !context.actor)) return event
  return {
    ...event,
    meta: { ...(context.requestId && { requestId: context.requestId }), ...(context.actor && { actor: { type: context.actor.type, id: context.actor.id } }) },
  }
}
