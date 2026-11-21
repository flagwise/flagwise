// A service's composition root: each service's src/service.ts defines how it boots from the
// runtime alone (its database, the bus, the timers, the clock) plus options of its own, so one
// process can run all of them, some, or one.

import type { Caller, Clock } from '@flagwise/kernel'
import type { Hono } from 'hono'
import type { EventBus } from './bus/memory-bus.ts'
import type { Database } from './db/database.ts'
import type { MigrationSet } from './db/migrate.ts'
import type { Scheduler } from './scheduler/timers.ts'

/** What every service boots from. */
export interface ServiceRuntime {
  /** Its storage: a service touches only its own tables and copies in it. */
  readonly db: Database
  readonly bus: EventBus
  readonly scheduler: Scheduler
  readonly clock: Clock
  /** Errors outside a request, of work the service runs itself. */
  readonly onError: (err: unknown) => void
}

/** Public routes, under /v1 at the edge, which authenticates and sets the caller. */
export type ServiceRoutes = Hono<{ Variables: { caller: Caller } }, any, any>

/** A booted service: its handlers are on the bus and its timers on the scheduler. */
export interface RunningService {
  /** Its public routes; the edge serves them in MODE api or all. */
  readonly routes?: ServiceRoutes
  /** Starts work of its own besides its handlers and timers; called in MODE worker or all. */
  start?(): void
  /** Stops that work and waits for what is in progress. */
  stop?(): Promise<void>
}

export interface ServiceDefinition<Options = void, Running extends RunningService = RunningService> {
  /** Its name, also its package name after `@flagwise/`. */
  readonly name: string
  /** Its tables; none for a service that keeps nothing. */
  readonly migrations?: MigrationSet
  /** Subscribes its handlers and timers and builds its routes. Starts nothing. */
  boot(runtime: ServiceRuntime, options: Options): Running
}

export function defineService<Options = void, Running extends RunningService = RunningService>(def: ServiceDefinition<Options, Running>): ServiceDefinition<Options, Running> {
  return def
}
