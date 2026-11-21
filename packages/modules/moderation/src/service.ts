// The moderation service's composition root: it boots from the runtime alone.

import { newId } from '@flagwise/kernel'
import { defineService } from '@flagwise/platform'
import { moderationRoutes } from './api/routes.ts'
import { moderationService, subscribeModeration } from './app/service.ts'
import { moderationMigrations } from './infra/pg-case-repository.ts'
import { pgCaseReads, pgModerationDeps } from './infra/pg-cases.ts'

/** Its handlers, its timers (case SLAs) and the /moderation routes. */
export const moderation = defineService({
  name: 'moderation',
  migrations: moderationMigrations,
  boot({ db, bus, scheduler, clock }) {
    const deps = pgModerationDeps(db, bus, {
      clock,
      newCaseId: () => newId('case', { clock }),
      newDecisionId: () => newId('dec', { clock }),
      newEventId: () => newId('evt', { clock }),
    })
    subscribeModeration(bus, deps, scheduler)
    return { routes: moderationRoutes({ read: pgCaseReads(db), ...moderationService(deps), clock }) }
  },
})
