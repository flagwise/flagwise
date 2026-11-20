// Public facade of the notifications module. Other modules import only this file.
// Owns: Notifications to people (members and end users) and their channels.
import { defineModule } from '@flagwise/kernel'

export const notificationsModule = defineModule({ name: 'notifications' })

export * from './domain/lifecycle.ts'
export * from './domain/routing.ts'
export { notificationsService, subscribeNotifications, type NotificationStore, type NotificationStores, type NotificationsService, type NotificationsServiceDeps } from './app/service.ts'
export { notificationsRoutes, type NotificationsEnv, type NotificationsRoutesDeps } from './api/routes.ts'
export { notificationsMigrations, pgNotificationStore, pgNotificationsDeps } from './infra/pg-notifications.ts'
export { notificationsTables } from './infra/schema.ts'
