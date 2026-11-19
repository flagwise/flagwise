// Public facade of the intake module. Other modules import only this file.
// Owns: Ingest API, evidence snapshots (sole writer to object storage), the pre-rules.
import { defineModule } from '@flagwise/kernel'

export const intakeModule = defineModule({ name: 'intake' })

export * from './domain/validate-report.ts'
export * from './domain/pre-rules.ts'
export * from './app/reports.ts'
export { subscribeIntake } from './app/handlers.ts'
export { intakeRoutes, type IntakeEnv } from './api/routes.ts'
export { pgReportStore, pgIntakeRunner, intakeMigrations } from './infra/pg-report-store.ts'
export { intakeTables } from './infra/schema.ts'
