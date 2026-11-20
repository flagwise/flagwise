// Drizzle definitions of the notifications tables; they must match migrations/ (a test checks it).

import { boolean, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('notifications')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const notificationsTable = schema.table('notifications', {
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  key: text('key').notNull(),
  id: text('id').notNull(),
  type: text('type').notNull(),
  values: jsonb('values').notNull().default({}),
  state: text('state').notNull(),
  raisedAt: ts('raised_at'),
  acknowledgedAt: ts('acknowledged_at'),
  resolvedAt: ts('resolved_at'),
  resolvedBy: text('resolved_by'),
})

export const notificationsTables = [notificationsTable] as const
