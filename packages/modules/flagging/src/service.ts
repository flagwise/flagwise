// The flagging service's composition root: it boots from the runtime and its evidence storage.

import { newId } from '@flagwise/kernel'
import { defineService, type ObjectStorage } from '@flagwise/platform'
import { flaggingRoutes } from './api/routes.ts'
import { subscribeFlagging } from './app/handlers.ts'
import type { FlaggingDeps } from './app/reports.ts'
import { flaggingMigrations, pgFlaggingRunner } from './infra/pg-report-store.ts'

export interface FlaggingOptions {
  /** Where evidence snapshots are written. */
  readonly storage: ObjectStorage
}

/** Its handlers (intake.erasure) and the /flagging routes. */
export const flagging = defineService<FlaggingOptions>({
  name: 'flagging',
  migrations: flaggingMigrations,
  boot({ db, bus, clock }, { storage }) {
    const deps: FlaggingDeps = { run: pgFlaggingRunner(db, bus), storage, clock, newReportId: () => newId('rpt', { clock }) }
    subscribeFlagging(bus, deps)
    return { routes: flaggingRoutes(deps) }
  },
})
