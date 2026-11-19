// Public facade of the alerts module. Other modules import only this file.
// Owns: SLA timers and alert channels.
import { defineModule } from '@flagwise/kernel'

export const alertsModule = defineModule({ name: 'alerts' })
