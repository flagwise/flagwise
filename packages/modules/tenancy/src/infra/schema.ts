// Drizzle definitions of the tenancy tables; they must match migrations/ (a test checks it).

import { boolean, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('tenancy')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const orgsTable = schema.table('orgs', {
  id: text('id').notNull(),
  name: text('name').notNull(),
  plan: text('plan').notNull(),
  createdAt: ts('created_at').notNull(),
  deletedAt: ts('deleted_at'),
})

export const appsTable = schema.table('apps', {
  orgId: text('org_id').notNull(),
  id: text('id').notNull(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull(),
  deletedAt: ts('deleted_at'),
})

export const apiKeysTable = schema.table('api_keys', {
  orgId: text('org_id').notNull(),
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

export const tenancyTables = [orgsTable, appsTable, apiKeysTable] as const
