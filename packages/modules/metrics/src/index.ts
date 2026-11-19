// Public facade of the metrics module. Other modules import only this file.
// Owns: Ops metrics, LLM token usage and cost estimate.
import { defineModule } from '@flagwise/kernel'

export const metricsModule = defineModule({ name: 'metrics' })
