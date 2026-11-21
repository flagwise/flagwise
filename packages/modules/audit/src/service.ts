// The audit service's composition root: it boots from the runtime alone.

import { defineService } from '@flagwise/platform'
import { auditRoutes } from './api/routes.ts'
import { auditReads, subscribeAudit } from './app/handlers.ts'
import { auditMigrations, pgAuditDeps } from './infra/pg-audit-store.ts'

/** Its handlers and the /audit routes. */
export const audit = defineService({
  name: 'audit',
  migrations: auditMigrations,
  boot({ db, bus, clock }) {
    const deps = pgAuditDeps(db, clock)
    subscribeAudit(bus, deps)
    return { routes: auditRoutes(auditReads(deps)) }
  },
})
