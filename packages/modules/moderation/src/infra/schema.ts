// Drizzle definitions of the cases tables; they must match migrations/ (a test checks it).

import { boolean, integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'
import { copyTable } from '@flagwise/platform'

const schema = pgSchema('cases')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const casesTable = schema.table('cases', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  id: text('id').notNull(),
  subjectExternalId: text('subject_external_id').notNull(),
  band: text('band').notNull(),
  state: text('state').notNull(),
  openedAt: ts('opened_at').notNull(),
  claimMemberId: text('claim_member_id'),
  claimedAt: ts('claimed_at'),
  claimLastActivityAt: ts('claim_last_activity_at'),
  triageSeverity: text('triage_severity'),
  triagePriority: integer('triage_priority'),
  triageSlaDueAt: ts('triage_sla_due_at'),
  triageSuggestedActionKeys: text('triage_suggested_action_keys').array(),
  decisionId: text('decision_id'),
  categoryId: text('category_id'),
  signals: text('signals').array(),
  injectionSuspected: boolean('injection_suspected'),
  classifiedBy: text('classified_by'),
  customCategoryId: text('custom_category_id'),
  triageApplied: text('triage_applied').array(),
  triageFlags: text('triage_flags').array(),
})

export const caseReportsTable = schema.table('case_reports', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  reportId: text('report_id').notNull(),
  caseId: text('case_id').notNull(),
  position: integer('position').notNull(),
  // What the reports said about the accounts, from before triage kept it itself: written and read
  // no more, kept only for triage's upgrade migration to start from; drop them in a later release.
  reporterExternalId: text('reporter_external_id'),
  reporterAccountCreatedAt: ts('reporter_account_created_at'),
  reportedAccountCreatedAt: ts('reported_account_created_at'),
})

export const decisionsTable = schema.table('decisions', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  id: text('id').notNull(),
  caseId: text('case_id').notNull(),
  outcome: text('outcome').notNull(),
  categoryId: text('category_id').notNull(),
  severity: text('severity').notNull(),
  actionKeys: text('action_keys').array().notNull(),
  decidedBy: text('decided_by').notNull(),
  decidedAt: ts('decided_at').notNull(),
  reportIds: text('report_ids').array().notNull(),
  publicReason: text('public_reason'),
  internalNote: text('internal_note'),
})

/** The failed action requests moderation heard of, and whether a retry answered them. */
export const actionFailuresTable = schema.table('action_failures', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  caseId: text('case_id').notNull(),
  actionRequestId: text('action_request_id').notNull(),
  failedAt: ts('failed_at').notNull(),
  answered: boolean('answered').notNull().default(false),
})

/** The copy of each app's policy, kept from policy.updated. */
export const policyCopiesTable = copyTable(schema, 'policy_copies')

export const moderationTables = [casesTable, caseReportsTable, decisionsTable, actionFailuresTable, policyCopiesTable] as const
