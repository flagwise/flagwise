// Drizzle definitions of the policy tables; they must match migrations/ (a test checks it).

import { boolean, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('policy')
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const actionKeysTable = schema.table('action_keys', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  key: text('key').notNull(),
  position: integer('position').notNull(),
  labelEn: text('label_en').notNull(),
  labelId: text('label_id'),
  description: text('description'),
  reverseKey: text('reverse_key'),
  autoAllowed: boolean('auto_allowed').notNull(),
  categories: text('categories').array().notNull(),
  updatedAt: ts('updated_at').notNull(),
  removedAt: ts('removed_at'),
})

export const categoriesTable = schema.table('categories', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  key: text('key').notNull(),
  position: integer('position').notNull(),
  labelEn: text('label_en').notNull(),
  labelId: text('label_id'),
  mapsTo: text('maps_to').array().notNull(),
  severity: text('severity'),
  slaHours: integer('sla_hours'),
  enabled: boolean('enabled').notNull(),
  updatedAt: ts('updated_at').notNull(),
  removedAt: ts('removed_at'),
})

export const llmSettingsTable = schema.table('llm_settings', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  rulesOnly: boolean('rules_only').notNull(),
  fallbackToRules: boolean('fallback_to_rules').notNull(),
  updatedAt: ts('updated_at').notNull(),
})

export const headsTable = schema.table('heads', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  version: integer('version').notNull(),
  document: jsonb('document').notNull(),
  updatedAt: ts('updated_at').notNull(),
})

export const policyTables = [actionKeysTable, categoriesTable, llmSettingsTable, headsTable] as const
