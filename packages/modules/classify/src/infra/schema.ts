// Drizzle definitions of the classify tables; they must match migrations/ (a test checks it).

import { boolean, doublePrecision, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'
import { copyTable } from '@flagwise/platform'

const schema = pgSchema('classify')

export const classificationsTable = schema.table('classifications', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  caseId: text('case_id').notNull(),
  reportId: text('report_id').notNull(),
  categoryId: text('category_id').notNull(),
  customCategoryId: text('custom_category_id'),
  confidence: doublePrecision('confidence'),
  signals: jsonb('signals').$type<string[]>().notNull(),
  summary: text('summary'),
  injectionSuspected: boolean('injection_suspected').notNull(),
  preRuleP0: boolean('pre_rule_p0').notNull(),
  classifiedBy: text('classified_by').$type<'llm' | 'rules'>().notNull(),
  rulesReason: text('rules_reason').$type<'rules_only' | 'llm_failed'>(),
  model: text('model'),
  promptHash: text('prompt_hash'),
  escalated: boolean('escalated').notNull(),
  escalationCapped: boolean('escalation_capped').notNull(),
  lowConfidence: boolean('low_confidence').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedTokens: integer('cached_tokens').notNull(),
  classifiedAt: timestamp('classified_at', { withTimezone: true }).notNull(),
})

export const reportScreeningsTable = schema.table('report_screenings', {
  orgId: text('org_id').notNull(),
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  reportId: text('report_id').notNull(),
  p0Signals: text('p0_signals').array().notNull(),
  injectionSuspected: boolean('injection_suspected').notNull(),
  reportedExternalId: text('reported_external_id'),
  reporterExternalId: text('reporter_external_id'),
})

/** The copy of each app's policy, kept from policy.updated. */
export const policyCopiesTable = copyTable(schema, 'policy_copies')

export const classifyTables = [classificationsTable, reportScreeningsTable, policyCopiesTable] as const
