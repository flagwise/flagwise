// Drizzle definitions of the triage tables; they must match migrations/ (a test checks it).

import { copyTable } from '@flagwise/platform'
import { boolean, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('triage')

/** The copy of each app's policy, kept from policy.updated. */
export const policyCopiesTable = copyTable(schema, 'policy_copies')

/** Triage's record of each case, from the cases' events. */
export const triageCasesTable = schema.table('cases', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  caseId: text('case_id').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
  reportIds: text('report_ids').array().notNull(),
  reports: jsonb('reports').notNull().default([]),
  state: text('state').notNull(),
  classification: jsonb('classification'),
  claimed: boolean('claimed').notNull().default(false),
  everClaimed: boolean('ever_claimed').notNull().default(false),
  corrected: boolean('corrected').notNull().default(false),
  decided: boolean('decided').notNull().default(false),
})

export const triageTables = [policyCopiesTable, triageCasesTable] as const
