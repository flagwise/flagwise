// Drizzle definitions of the apps tables; they must match migrations/ (a test checks it).

import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('apps')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const appsTable = schema.table('apps', {
  id: text('id').notNull(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull(),
  deletedAt: ts('deleted_at'),
})

export const appsTables = [appsTable] as const
