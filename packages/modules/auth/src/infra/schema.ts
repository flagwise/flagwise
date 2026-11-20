// Drizzle definitions of the auth tables; they must match migrations/ (a test checks it).

import { boolean, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('auth')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** Auth's copy of the apps. */
export const appsTable = schema.table('apps', {
  id: text('id').notNull(),
  deletedAt: ts('deleted_at'),
})

export const apiKeysTable = schema.table('api_keys', {
  appId: text('app_id').notNull(),
  id: text('id').notNull(),
  livemode: boolean('livemode').notNull(),
  lookup: text('lookup').notNull(),
  hash: text('hash').notNull(),
  scopes: text('scopes').array().notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
})

export const authTables = [appsTable, apiKeysTable] as const
