// What triage needs from the outside: its own record of each case, built from the cases' events,
// its copy of each app's policy, and a unit of work that publishes its facts with its writes.

import type { Policy } from '@flagwise/contracts'
import type { TenantRef } from '@flagwise/kernel'
import type { DocumentCopy, UnitOfWork } from '@flagwise/platform'
import type { TriageConfig } from '../domain/triage.ts'

/** What a report said about the accounts; account times null when not given. */
export interface ReportAccounts {
  readonly reportId: string
  readonly reporterExternalId: string
  readonly reporterAccountCreatedAt: Date | null
  readonly reportedAccountCreatedAt: Date | null
}

/** The classification triage triages a case on: the last one it triaged, or a moderator's category on it. */
export interface TriageClassification {
  readonly categoryId: string
  /** The app's category of the case, when it has one. */
  readonly customCategoryId: string | null
  readonly signals: readonly string[]
  readonly injectionSuspected: boolean
  readonly preRuleP0: boolean
  readonly classifiedBy: 'llm' | 'rules'
}

/**
 * Triage's record of a case, from the facts moderation and classify publish: when it opened, its
 * reports, what they said about the accounts, and whether a moderator has worked on it.
 * - classifying: not triaged yet; triaged: triage published case.triaged; untriaged: triage
 *   published case.untriaged and waits for the LLM again or a moderator.
 */
export interface TriageCase {
  readonly tenant: TenantRef
  readonly caseId: string
  /** The reported account, from case.opened; unset on records from before it was kept. */
  readonly subjectExternalId?: string | null
  readonly openedAt: Date
  /** In the order they joined; the first opened the case. */
  readonly reportIds: readonly string[]
  /** The facts of the reports that carried them, in the same order. */
  readonly reports: readonly ReportAccounts[]
  readonly state: 'classifying' | 'triaged' | 'untriaged'
  /** null until classify classified the case. */
  readonly classification: TriageClassification | null
  /** A moderator holds the case now. */
  readonly claimed: boolean
  /** A moderator has held it at some point. */
  readonly everClaimed: boolean
  /** A moderator changed its category or severity. */
  readonly corrected: boolean
  readonly decided: boolean
}

export type TriageCaseChange = Partial<Pick<TriageCase, 'state' | 'classification' | 'claimed' | 'everClaimed' | 'corrected' | 'decided'>>

/** Every method only sees cases of the given tenant (app and livemode). */
export interface TriageCaseStore {
  find(tenant: TenantRef, caseId: string): Promise<TriageCase | null>
  /** Keeps a newly opened case; one already kept stays as it is. */
  open(record: TriageCase): Promise<void>
  /** Appends a report (with its facts, when given) to a kept case; a report already in it changes nothing. False when no such case is kept. */
  attach(tenant: TenantRef, caseId: string, reportId: string, facts: Omit<ReportAccounts, 'reportId'> | null): Promise<boolean>
  /** Applies `change` to a kept case; false when there is none. */
  change(tenant: TenantRef, caseId: string, change: TriageCaseChange): Promise<boolean>
  /**
   * Erases an account from the kept cases: where it is the reported account, its id becomes
   * `erasedId` and its account age is dropped from every report; where it reported, its id becomes
   * `erasedId` and its account age is dropped. Returns how many cases it changed.
   */
  eraseAccount(tenant: TenantRef, externalId: string, erasedId: string): Promise<number>
}

export interface TriageStores {
  readonly cases: TriageCaseStore
}

export interface TriageDeps {
  readonly uow: UnitOfWork<TriageStores>
  /** Triage's copy of each app's policy, kept from policy.updated. */
  readonly policy: DocumentCopy<Policy>
  /** Default DEFAULT_TRIAGE_CONFIG. */
  readonly config?: TriageConfig
}
