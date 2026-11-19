// Public facade of the triage module. Other modules import only this file.
// Owns: Deterministic rules: severity, priority, SLA, suggested action; triaging each case from the
// cases' and classify's events, publishing case.triaged and case.untriaged.
import { defineModule } from '@flagwise/kernel'

export const triageModule = defineModule({ name: 'triage' })

export * from './domain/triage.ts'
export * from './domain/global-rules.ts'
export * from './app/ports.ts'
export { triageCase, type AccountFacts, type CaseTriageInput, type CaseTriageResult } from './app/case-triage.ts'
export { subscribeTriage, TRIAGE_EVENT_TYPES } from './app/handlers.ts'
export { pgTriagePolicyCopy } from './infra/pg-policy-copy.ts'
export { pgTriageCaseStore, pgTriageDeps } from './infra/pg-triage-case-store.ts'
export { triageMigrations } from './infra/migrations.ts'
export { triageTables } from './infra/schema.ts'
