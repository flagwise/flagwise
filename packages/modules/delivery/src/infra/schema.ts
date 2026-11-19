// Drizzle definitions of the delivery tables; they must match migrations/ (a test checks it).

import { boolean, integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'

const schema = pgSchema('delivery')

export const actionRequestsTable = schema.table('action_requests', {
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
  id: text('id').notNull(),
  caseId: text('case_id').notNull(),
  decisionId: text('decision_id').notNull(),
  position: integer('position').notNull(),
  actionKey: text('action_key').notNull(),
  status: text('status').notNull(),
  failReason: text('fail_reason'),
  retryId: text('retry_id'),
  replacedBy: text('replaced_by'),
})

const tenantColumns = () => ({
  appId: text('app_id').notNull(),
  livemode: boolean('livemode').notNull(),
})
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const webhookSecretsTable = schema.table('webhook_secrets', {
  ...tenantColumns(),
  version: integer('version').notNull(),
  sealed: text('sealed').notNull(),
  createdAt: at('created_at').notNull(),
  expiresAt: at('expires_at'),
})

export const webhookEndpointsTable = schema.table('webhook_endpoints', {
  ...tenantColumns(),
  id: text('id').notNull(),
  url: text('url').notNull(),
  eventTypes: text('event_types').array(),
  createdAt: at('created_at').notNull(),
})

export const webhookEventsTable = schema.table('webhook_events', {
  ...tenantColumns(),
  id: text('id').notNull(),
  sourceId: text('source_id').notNull(),
  type: text('type').notNull(),
  body: text('body').notNull(),
  createdAt: at('created_at').notNull(),
})

export const webhookDeliveriesTable = schema.table('webhook_deliveries', {
  ...tenantColumns(),
  eventId: text('event_id').notNull(),
  endpointId: text('endpoint_id').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: at('next_attempt_at'),
  leasedUntil: at('leased_until'),
  createdAt: at('created_at').notNull(),
  finishedAt: at('finished_at'),
})

export const webhookAttemptsTable = schema.table('webhook_attempts', {
  ...tenantColumns(),
  eventId: text('event_id').notNull(),
  endpointId: text('endpoint_id').notNull(),
  number: integer('number').notNull(),
  at: at('at').notNull(),
  status: integer('status'),
  durationMs: integer('duration_ms').notNull(),
  delivered: boolean('delivered').notNull(),
  error: text('error'),
})

export const deliveryTables = [actionRequestsTable, webhookSecretsTable, webhookEndpointsTable, webhookEventsTable, webhookDeliveriesTable, webhookAttemptsTable] as const
