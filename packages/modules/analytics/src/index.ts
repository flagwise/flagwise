// Public facade of the analytics module. Other modules import only this file.
// Owns: Ops metrics, LLM token usage and cost estimate.
import { defineModule } from '@flagwise/kernel'

export const analyticsModule = defineModule({ name: 'analytics' })
