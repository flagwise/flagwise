// Drizzle definitions of the intake tables; they must match migrations/ (a test checks it).

import { boolean, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('intake')

export const reportsTable = schema.table('reports', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  id: text('id').notNull(),
  reporterExternalId: text('reporter_external_id').notNull(),
  reportedExternalId: text('reported_external_id').notNull(),
  category: text('category').notNull(),
  snapshotKey: text('snapshot_key').notNull(),
  idempotencyKey: text('idempotency_key'),
  requestHash: text('request_hash').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  caseId: text('case_id'),
  joinedExistingCase: boolean('joined_existing_case'),
})

export const intakeTables = [reportsTable] as const
