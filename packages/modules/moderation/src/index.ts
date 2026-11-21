// Public facade of the moderation module. Other modules import only this file.
// Owns: Case merging, queue, claiming, decisions, and the case's state from triage's and delivery's facts.

export { moderation } from './service.ts'

export * from './domain/case-state.ts'
export * from './domain/sla.ts'
export * from './app/ports.ts'
export { receiveReport, type ReportReceived, type ReceiveReportResult } from './app/receive-report.ts'
export {
  claimCase,
  releaseCase,
  decideCase,
  correctCase,
  retryActions,
  CaseWorkError,
  CLAIM_IDLE_MS,
  type CaseRef,
  type DecideInput,
  type CorrectInput,
  type RetryActionsInput,
} from './app/work-case.ts'
export { moderationService, subscribeModeration, type ModerationService, type ModerationServiceDeps, type ModerationStores } from './app/service.ts'
export { moderationRoutes, caseBody, type ModerationEnv, type ModerationRoutesDeps } from './api/routes.ts'
export { pgCaseRepository, moderationMigrations } from './infra/pg-case-repository.ts'
export { moderationTables } from './infra/schema.ts'
export { pgModerationPolicyCopy } from './infra/pg-policy-copy.ts'
export { pgModerationDeps, pgCaseReads, type PgModerationOptions } from './infra/pg-cases.ts'
