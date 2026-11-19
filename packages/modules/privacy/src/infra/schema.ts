// Drizzle definitions of the privacy tables; they must match migrations/.

import { boolean, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('privacy')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const erasuresTable = schema.table('erasures', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  id: text('id').notNull(),
  subjectExternalId: text('subject_external_id').notNull(),
  requestedAt: ts('requested_at').notNull(),
  deadlineAt: ts('deadline_at').notNull(),
  expected: text('expected').array(),
  groups: jsonb('groups').notNull().default({}),
  completedAt: ts('completed_at'),
  heldItems: integer('held_items').notNull().default(0),
})

export const privacyTables = [erasuresTable] as const
