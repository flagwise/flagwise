// What the cases use cases need from the outside world. Production code gets Postgres-backed
// implementations; tests get the in-memory fakes in test/fakes.ts.

import type { Clock, TenantRef } from '@flagwise/kernel'
import type { CaseState } from '../domain/case-state.ts'

/** Reports with a P0 signal never share a case with ordinary reports. */
export type SeverityBand = 'p0' | 'standard'

export interface CaseRecord {
  readonly id: string
  readonly tenant: TenantRef
  readonly subjectExternalId: string
  readonly band: SeverityBand
  readonly state: CaseState
  /** In the order they were attached; the first one opened the case. */
  readonly reportIds: readonly string[]
  readonly openedAt: Date
  /** Who works the case right now; missing or null when nobody does. */
  readonly claim?: CaseClaim | null
  /** The decision, once made. */
  readonly decision?: Decision | null
  /** Result of triage, once triaged. */
  readonly triage?: CaseTriage | null
  /** The classification's facts, copied from case.classified at triage; left out until then. */
  readonly classification?: CaseClassification
}

/**
 * The facts of a case's classification that the queue filters and shows. The summary and the
 * evidence stay with the modules that wrote them (classify, intake) and are read from their routes.
 */
export interface CaseClassification {
  readonly categoryId: string
  readonly signals: readonly string[]
  readonly injectionSuspected: boolean
  readonly classifiedBy: 'llm' | 'rules'
  /** The app's own category of the case, when it has one; left out otherwise. */
  readonly customCategoryId?: string | null
}

export interface CaseTriage {
  readonly severity: Severity
  readonly priority: number
  readonly slaDueAt: Date
  readonly suggestedActionKeys: readonly string[]
  /** The triage rules that applied (such as `reported_new_account`), in triage's order; left out on cases triaged before they were kept. */
  readonly applied?: readonly string[]
  /** Triage's flags (such as `reported_age_unknown`); left out like `applied`. */
  readonly flags?: readonly string[]
}

/** What a report said about the accounts, as facts triage weighs; moderation only passes them on in its events. */
export interface ReportFacts {
  readonly reporterExternalId: string
  /** When the reporter's account was created, as the tenant said; null when not given. */
  readonly reporterAccountCreatedAt: Date | null
  /** When the reported account was created, as the tenant said; null when not given. */
  readonly reportedAccountCreatedAt: Date | null
}

export interface CaseClaim {
  readonly memberId: string
  readonly claimedAt: Date
  readonly lastActivityAt: Date
}

export type Severity = 'P0' | 'P1' | 'P2'

export interface Decision {
  readonly id: string
  readonly outcome: 'violation' | 'no_violation'
  readonly categoryId: string
  readonly severity: Severity
  readonly actionKeys: readonly string[]
  readonly decidedBy: string
  readonly decidedAt: Date
  /** The reports the decision was made on: the ones shown to the moderator, in the case's order. */
  readonly reportIds: readonly string[]
  readonly publicReason?: string
  readonly internalNote?: string
}

/** A use case gave up because the case kept changing under it, after its retries. */
export class CaseChangedError extends Error {
  constructor(caseId: string) {
    super(`Case ${caseId} kept changing; try again`)
    this.name = 'CaseChangedError'
  }
}

/**
 * What a conditional change requires of the stored case; every field given must hold. The check
 * and the change happen in one step, so two writers cannot both pass a condition only one of them
 * should.
 */
export interface CaseCondition {
  /** The case is in one of these states. */
  readonly states: readonly CaseState[]
  /** The claim is held by this member, or by nobody when null. */
  readonly claimedBy?: string | null
  /** The claim's last activity is at or before this time: the claim is idle. */
  readonly claimIdleSince?: Date
  /** The case's decision has this id. */
  readonly decisionId?: string
}

/** The fields a conditional change sets; fields left out keep their value. At least one is given. */
export interface CaseChange {
  readonly state?: CaseState
  readonly claim?: CaseClaim | null
  readonly triage?: CaseTriage
  readonly classification?: CaseClassification
  /** Saved once: a case's decision is never replaced. */
  readonly decision?: Decision
}

/** Every method only sees cases of the given tenant (org, app and livemode). */
export interface CaseRepository {
  findById(tenant: TenantRef, caseId: string): Promise<CaseRecord | null>
  findBySubject(tenant: TenantRef, subjectExternalId: string): Promise<readonly CaseRecord[]>
  findByReportId(tenant: TenantRef, reportId: string): Promise<CaseRecord | null>
  /**
   * Until the current transaction ends, another caller locking the same tenant and subject waits.
   * Serializes the reports about one account, so two first reports cannot open two cases.
   */
  lockSubject(tenant: TenantRef, subjectExternalId: string): Promise<void>
  insert(record: CaseRecord): Promise<void>
  /** Applies `change` only if the case exists and meets `condition`; true when it did. */
  change(tenant: TenantRef, caseId: string, condition: CaseCondition, change: CaseChange): Promise<boolean>
  /**
   * Appends `reportId` to the case's reports only if the case is in one of `states`; true when it
   * did. While it runs, the case cannot move to another state.
   */
  attachReport(tenant: TenantRef, caseId: string, reportId: string, states: readonly CaseState[]): Promise<boolean>
  /** Notes a failed action request of the case; false, changing nothing, when it was noted before. */
  addActionFailure(tenant: TenantRef, caseId: string, actionRequestId: string, at: Date): Promise<boolean>
  /** The case's noted failures no retry has answered yet, oldest first. */
  openActionFailures(tenant: TenantRef, caseId: string): Promise<readonly string[]>
  /** Marks the case's noted failures as answered by a retry. */
  answerActionFailures(tenant: TenantRef, caseId: string, actionRequestIds: readonly string[]): Promise<void>
}

/** The states the queue shows when no state filter is given. */
export const QUEUE_STATES: readonly CaseState[] = ['untriaged', 'open', 'claimed']

export interface CaseQuery {
  /** Default: QUEUE_STATES. */
  readonly states?: readonly CaseState[]
  readonly severities?: readonly Severity[]
  readonly categoryIds?: readonly string[]
  /** Cases claimed by this member; null for unclaimed cases. */
  readonly claimedBy?: string | null
  /** true: SLA due time passed at `now`; false: not passed, or no SLA yet. */
  readonly slaBreached?: boolean
  /** Cases about this account. */
  readonly subjectExternalId?: string
  /** 'urgency' (default): most urgent first; 'recent': most recently opened first. */
  readonly order?: CaseOrder
  /** The time slaBreached is judged at. */
  readonly now: Date
  /** 1 to 100; default 50. */
  readonly limit?: number
  /** From the previous page's nextCursor. */
  readonly cursor?: string
}

export type CaseOrder = 'urgency' | 'recent'

export interface CasePage {
  readonly data: readonly CaseRecord[]
  /** null on the last page. */
  readonly nextCursor: string | null
}

/** The read side the cases routes need. */
export interface CaseReader {
  findById(tenant: TenantRef, caseId: string): Promise<CaseRecord | null>
  /**
   * Cases of the tenant matching every filter given. By default most urgent first: by triage
   * priority (higher first; untriaged cases last), then SLA due time (sooner first), then id. With
   * `order: 'recent'`, by opened time (latest first), then id. The cursor is opaque and belongs to
   * its order; a malformed one, or one of the other order, is a RangeError.
   */
  list(tenant: TenantRef, query: CaseQuery): Promise<CasePage>
}

export type CasesEvent =
  | {
      readonly type: 'case.opened'
      readonly tenant: TenantRef
      readonly caseId: string
      readonly reportId: string
      readonly subjectExternalId: string
      readonly band: SeverityBand
      /** What the report said about the accounts, when it said it. */
      readonly facts?: ReportFacts
      readonly occurredAt: Date
    }
  | {
      readonly type: 'case.report_attached'
      readonly tenant: TenantRef
      readonly caseId: string
      readonly reportId: string
      /** What the report said about the accounts, when it said it. */
      readonly facts?: ReportFacts
      readonly occurredAt: Date
    }

  | {
      readonly type: 'case.claimed'
      readonly tenant: TenantRef
      readonly caseId: string
      readonly memberId: string
      readonly occurredAt: Date
    }
  | {
      readonly type: 'case.released'
      readonly tenant: TenantRef
      readonly caseId: string
      /** The member who held the claim. */
      readonly memberId: string
      readonly reason: 'released' | 'forced' | 'idle'
      readonly occurredAt: Date
    }
  | {
      readonly type: 'case.decided'
      readonly tenant: TenantRef
      readonly caseId: string
      /** The reported account, so the actions it needs can name it. */
      readonly subjectExternalId: string
      readonly decisionId: string
      readonly outcome: Decision['outcome']
      readonly categoryId: string
      readonly severity: Severity
      readonly actionKeys: readonly string[]
      /** The reports the decision was made on. */
      readonly reportIds: readonly string[]
      readonly decidedBy: string
      readonly occurredAt: Date
    }
  | {
      /** A moderator changed the category or severity before deciding; triage triages it again. */
      readonly type: 'case.corrected'
      readonly tenant: TenantRef
      readonly caseId: string
      /** severity is null when the case was untriaged: the moderator triages it by hand. */
      readonly before: { readonly categoryId: string; readonly severity: Severity | null }
      /** The moderator's category, and the severity they gave (null to take the category's own). */
      readonly after: { readonly categoryId: string; readonly severity: Severity | null }
      readonly correctedBy: string
      readonly occurredAt: Date
    }
  | {
      /**
       * A moderator answered the failed actions of a decision: retry them, pick others, or none.
       * Delivery replaces the failed requests in `replaces` with one per action key.
       */
      readonly type: 'case.actions_retried'
      readonly tenant: TenantRef
      readonly caseId: string
      readonly decisionId: string
      readonly subjectExternalId: string
      readonly categoryId: string
      readonly severity: Severity
      readonly actionKeys: readonly string[]
      /** The failed requests the retry answers: the ones moderation heard of that no retry answered. */
      readonly replaces: readonly string[]
      readonly retriedBy: string
      readonly occurredAt: Date
    }

export interface EventPublisher {
  publish(event: CasesEvent): Promise<void>
}

export interface CasesDeps {
  readonly cases: CaseRepository
  readonly events: EventPublisher
  readonly clock: Clock
  readonly newCaseId: () => string
}

/** Which action keys a category allows (from moderation's copy of the app's policy). */
export interface ActionCatalog {
  /** null when the category does not exist in the app. */
  allowedActionKeys(tenant: TenantRef, categoryId: string): Promise<readonly string[] | null>
}

export interface CaseWorkDeps extends CasesDeps {
  readonly catalog: ActionCatalog
  readonly newDecisionId: () => string
}
