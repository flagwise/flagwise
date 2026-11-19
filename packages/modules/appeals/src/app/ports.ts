// What the appeals use cases need. Production code gets Postgres-backed implementations; tests get
// the in-memory fakes in test/fakes.ts.

import type { Clock, TenantRef } from '@flagwise/kernel'

/** The appeals module's own copy of a decision, built from case.decided events. */
export interface DecisionView {
  readonly decisionId: string
  readonly tenant: TenantRef
  readonly caseId: string
  readonly outcome: 'violation' | 'no_violation'
  readonly actionKeys: readonly string[]
  readonly decidedBy: string
  readonly decidedAt: Date
  readonly subjectExternalId: string
  readonly reporterExternalIds: readonly string[]
}

export type Appellant = 'reported' | 'reporter'

export interface AppealRecord {
  readonly id: string
  readonly tenant: TenantRef
  readonly decisionId: string
  readonly caseId: string
  readonly appellant: Appellant
  readonly appellantExternalId: string
  readonly text: string
  readonly filedAt: Date
  readonly dueAt: Date
  readonly status: 'open' | 'upheld' | 'overturned'
  readonly resolvedBy: string | null
  readonly resolvedAt: Date | null
  readonly version: number
}

export class VersionConflictError extends Error {
  constructor(id: string) {
    super(`Appeal ${id} was changed by someone else`)
    this.name = 'VersionConflictError'
  }
}

export interface DecisionRepository {
  findById(tenant: TenantRef, decisionId: string): Promise<DecisionView | null>
}

/** Every method only sees appeals of the given tenant. */
export interface AppealRepository {
  findById(tenant: TenantRef, appealId: string): Promise<AppealRecord | null>
  findByDecision(tenant: TenantRef, decisionId: string): Promise<readonly AppealRecord[]>
  insert(record: AppealRecord): Promise<void>
  /** Saves only if the stored version equals expectedVersion; else throws VersionConflictError. */
  update(record: AppealRecord, expectedVersion: number): Promise<void>
}

/** The reverse of each tenant action key (e.g. suspend_7d -> unsuspend), from tenancy config. */
export interface ReverseKeys {
  reverseOf(tenant: TenantRef, actionKey: string): Promise<string | null>
}

export type AppealsEvent =
  | {
      readonly type: 'appeal.filed'
      readonly tenant: TenantRef
      readonly appealId: string
      readonly decisionId: string
      readonly caseId: string
      readonly appellant: Appellant
      readonly dueAt: Date
      readonly occurredAt: Date
    }
  | {
      readonly type: 'appeal.resolved'
      readonly tenant: TenantRef
      readonly appealId: string
      readonly decisionId: string
      readonly caseId: string
      readonly outcome: 'upheld' | 'overturned'
      /** Tenant actions to request so the sanction is undone. */
      readonly reverseActionKeys: readonly string[]
      /** Actions of the decision that have no reverse key. */
      readonly irreversibleActionKeys: readonly string[]
      /** Scoring should reverse the decision's points. */
      readonly revokePoints: boolean
      /** The case needs a new decision (a reporter won against "no violation"). */
      readonly reopenCase: boolean
      readonly resolvedBy: string
      readonly occurredAt: Date
    }

export interface AppealsDeps {
  readonly decisions: DecisionRepository
  readonly appeals: AppealRepository
  readonly reverseKeys: ReverseKeys
  readonly events: { publish(event: AppealsEvent): Promise<void> }
  readonly clock: Clock
  readonly newAppealId: () => string
}
