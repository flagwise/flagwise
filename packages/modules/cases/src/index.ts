// Public facade of the cases module. Other modules import only this file.
// Owns: Case merging, queue, claiming, decisions, and the case's state from triage's and delivery's facts.
import { defineModule } from '@flagwise/kernel'

export const casesModule = defineModule({ name: 'cases' })

export * from './domain/case-state.ts'
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
export { casesService, subscribeCases, type CasesService, type CasesServiceDeps, type CasesStores } from './app/service.ts'
export { casesRoutes, caseBody, type CasesEnv, type CasesRoutesDeps } from './api/routes.ts'
export { pgCaseRepository, casesMigrations } from './infra/pg-case-repository.ts'
export { casesTables } from './infra/schema.ts'
export { pgCasesPolicyCopy } from './infra/pg-policy-copy.ts'
export { pgCasesDeps, pgCaseReads, type PgCasesOptions } from './infra/pg-cases.ts'
