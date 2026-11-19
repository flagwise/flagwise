// Triage of a case: the app's category rule from the policy, the classification's facts and what
// the case's reports said about the accounts, through the deterministic rules. No violation score
// or reporter credibility yet, so those weigh nothing.

import { policyCategory, type Policy } from '@flagwise/contracts'
import { appCategoryRule } from '../domain/global-rules.ts'
import { DEFAULT_TRIAGE_CONFIG, triage, type AppliedRule, type CategoryRule, type Severity, type TriageConfig, type TriageFlag } from '../domain/triage.ts'

/** What triage gives a case. */
export interface CaseTriageResult {
  readonly severity: Severity
  readonly priority: number
  readonly slaDueAt: Date
  readonly suggestedActionKeys: readonly string[]
  readonly applied: readonly AppliedRule[]
  readonly flags: readonly TriageFlag[]
}

/** What a report said about the accounts; account times null when not given. */
export interface AccountFacts {
  readonly reporterExternalId: string
  readonly reporterAccountCreatedAt: Date | null
  readonly reportedAccountCreatedAt: Date | null
}

export interface CaseTriageInput {
  readonly openedAt: Date
  readonly policy: Policy
  readonly categoryId: string
  /** The app's category of the case, when it has one. */
  readonly customCategoryId: string | null
  /** A moderator's severity in place of the category's own; P0 rules still force P0. */
  readonly severity?: Severity | undefined
  readonly classification: { readonly signals: readonly string[]; readonly injectionSuspected: boolean; readonly preRuleP0: boolean }
  /** The facts of the case's reports that carried them, in the order the reports joined. */
  readonly reports: readonly AccountFacts[]
  readonly config?: TriageConfig
}

/**
 * Triages a case: the rule of its category with the app's category on top (appCategoryRule), the
 * moderator's severity in its place when given (then the category's own SLA no longer applies),
 * the reported account's creation time (the first one a report gave), and each reporter once with
 * the account time of their first report.
 */
export function triageCase(input: CaseTriageInput): CaseTriageResult {
  const app = input.customCategoryId ? policyCategory(input.policy, input.customCategoryId) : null
  const rule = withSeverity(appCategoryRule(input.categoryId, app), input.severity)
  const reporters = new Map<string, Date | undefined>()
  for (const f of input.reports) if (!reporters.has(f.reporterExternalId)) reporters.set(f.reporterExternalId, f.reporterAccountCreatedAt ?? undefined)
  const reportedAccountCreatedAt = input.reports.find((f) => f.reportedAccountCreatedAt !== null)?.reportedAccountCreatedAt ?? undefined
  const { signals, injectionSuspected, preRuleP0 } = input.classification
  const result = triage(
    {
      openedAt: input.openedAt,
      category: rule,
      classification: { signals, injectionSuspected, preRuleP0 },
      reported: { violationScore: 0, accountCreatedAt: reportedAccountCreatedAt },
      reporters: [...reporters.values()].map((accountCreatedAt) => ({ accountCreatedAt, credibility: null })),
    },
    input.config ?? DEFAULT_TRIAGE_CONFIG,
  )
  return {
    severity: result.severity,
    priority: result.priority,
    slaDueAt: result.slaDueAt,
    suggestedActionKeys: result.suggestedActionKeys,
    applied: result.applied,
    flags: result.flags,
  }
}

/** The rule with the moderator's severity in place of its own; its custom SLA is for its own. */
function withSeverity(rule: CategoryRule, severity: Severity | undefined): CategoryRule {
  if (severity === undefined || severity === rule.severity) return rule
  const { slaHours: _ownSla, ...rest } = rule
  return { ...rest, severity }
}
