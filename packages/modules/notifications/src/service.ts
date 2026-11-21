// The notifications service's composition root: it boots from the runtime alone.

import { newId } from '@flagwise/kernel'
import { defineService } from '@flagwise/platform'
import { notificationsRoutes } from './api/routes.ts'
import { notificationsService, subscribeNotifications } from './app/service.ts'
import { notificationsMigrations, pgNotificationsDeps } from './infra/pg-notifications.ts'

/** Its handlers and the /notifications routes. */
export const notifications = defineService({
  name: 'notifications',
  migrations: notificationsMigrations,
  boot({ db, bus, clock }) {
    const deps = pgNotificationsDeps(db, bus, { clock, newNotificationId: () => newId('ntf', { clock }) })
    subscribeNotifications(bus, deps)
    return { routes: notificationsRoutes(notificationsService(deps)) }
  },
})
