// Public facade of the flagging module. Other modules import only this file.
// Owns: Taking flagged material in (user reports), evidence snapshots (sole writer to object storage), the pre-rules.
import { defineModule } from '@flagwise/kernel'

export const flaggingModule = defineModule({ name: 'flagging' })

export * from './domain/validate-report.ts'
export * from './domain/pre-rules.ts'
export * from './app/reports.ts'
export { subscribeFlagging } from './app/handlers.ts'
export { flaggingRoutes, type FlaggingEnv } from './api/routes.ts'
export { pgReportStore, pgFlaggingRunner, flaggingMigrations } from './infra/pg-report-store.ts'
export { flaggingTables } from './infra/schema.ts'
