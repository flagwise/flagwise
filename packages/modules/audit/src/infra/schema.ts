// Drizzle definitions of the audit tables; they must match migrations/ (a test checks it).

import { bigint, boolean, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('audit')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const entriesTable = schema.table('entries', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  at: ts('at').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  facts: jsonb('facts').notNull(),
  pii: jsonb('pii'),
  piiSalt: text('pii_salt'),
  piiDigest: text('pii_digest'),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  caseId: text('case_id'),
  subjectExternalId: text('subject_external_id'),
})

export const checkpointsTable = schema.table('checkpoints', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  hash: text('hash').notNull(),
  purgedAt: ts('purged_at').notNull(),
})

export const auditTables = [entriesTable, checkpointsTable] as const
