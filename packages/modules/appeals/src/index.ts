// Public facade of the appeals module. Other modules import only this file.
// Owns: Decision notices, appeal pages and queue.
import { defineModule } from '@flagwise/kernel'

export const appealsModule = defineModule({ name: 'appeals' })
