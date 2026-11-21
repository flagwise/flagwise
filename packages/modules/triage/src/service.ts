// The triage service's composition root: it boots from the runtime alone.

import { defineService } from '@flagwise/platform'
import { subscribeTriage } from './app/handlers.ts'
import { triageMigrations } from './infra/migrations.ts'
import { pgTriageDeps } from './infra/pg-triage-case-store.ts'

/** Its handlers; triage has no routes. */
export const triage = defineService({
  name: 'triage',
  migrations: triageMigrations,
  boot({ db, bus }) {
    subscribeTriage(bus, pgTriageDeps(db, bus))
    return {}
  },
})
