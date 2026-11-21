// The policy service's composition root: it boots from the runtime alone.

import { newId } from '@flagwise/kernel'
import { defineService } from '@flagwise/platform'
import { policyRoutes } from './api/routes.ts'
import { subscribePolicy } from './app/handlers.ts'
import { busPolicyEvents } from './infra/bus-events.ts'
import { pgPolicy, policyMigrations } from './infra/pg-policy-store.ts'

/** Its handlers (policy.erasure) and the /policy routes, which publish policy.updated. */
export const policy = defineService({
  name: 'policy',
  migrations: policyMigrations,
  boot({ db, bus, clock }) {
    subscribePolicy(bus, { clock })
    const newEventId = () => newId('evt', { clock })
    return { routes: policyRoutes(pgPolicy(db, { clock, events: (tx) => busPolicyEvents(bus, tx, newEventId) })) }
  },
})
