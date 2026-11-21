// The privacy service's composition root: it boots from the runtime alone.

import { newId } from '@flagwise/kernel'
import { defineService } from '@flagwise/platform'
import { privacyRoutes } from './api/routes.ts'
import { privacyService, subscribePrivacy } from './app/handlers.ts'
import { pgPrivacyDeps, privacyMigrations } from './infra/pg-erasure-store.ts'

/** Its handlers and the /privacy routes. */
export const privacy = defineService({
  name: 'privacy',
  migrations: privacyMigrations,
  boot({ db, bus, clock }) {
    const deps = pgPrivacyDeps(db, bus, { clock, newErasureId: () => newId('ers', { clock }) })
    subscribePrivacy(bus, deps)
    return { routes: privacyRoutes({ ...privacyService(deps), clock }) }
  },
})
