// Public facade of the disputes module. Other modules import only this file.
// Owns: Appeals from either party: filing window, appeal page and queue.
import { defineModule } from '@flagwise/kernel'

export const disputesModule = defineModule({ name: 'disputes' })
