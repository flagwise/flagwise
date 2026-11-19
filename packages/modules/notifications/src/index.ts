// Public facade of the notifications module. Other modules import only this file.
// Owns: Notifications to people (members and end users) and their channels.
import { defineModule } from '@flagwise/kernel'

export const notificationsModule = defineModule({ name: 'notifications' })
