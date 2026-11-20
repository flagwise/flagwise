// Which events the audit log records, and what each entry says: who did it, to what, and the
// non-personal facts. Events carry no personal data, so entries made from them have none either.

import type { AuditInput, Json, Ref } from './chain.ts'

/** A published event as the audit log reads it: its data is the event's JSON. */
export interface RecordedEvent {
  readonly id: string
  readonly type: string
  readonly data: unknown
  readonly meta?: { readonly requestId?: string; readonly actor?: Ref; readonly publishedAt?: Date }
}

/** An entry to append, with the ids it is found by. */
export interface AuditRecord {
  readonly input: AuditInput
  readonly caseId: string | null
  readonly subjectExternalId: string | null
}

/** The system itself: the worker's handlers, timers and rules. */
export const SYSTEM_ACTOR: Ref = { type: 'system', id: 'system' }

type Spec = {
  /** The target's type and the data field holding its id. */
  readonly target: readonly [type: string, field: string]
  /** Fact name to data field, copied when present. */
  readonly facts: Readonly<Record<string, string>>
}

const SPECS: Readonly<Record<string, Spec>> = {
  'report.received': { target: ['report', 'reportId'], facts: { subject_external_id: 'subjectExternalId', p0_signal: 'p0Signal' } },
  'case.opened': { target: ['case', 'caseId'], facts: { report_id: 'reportId', subject_external_id: 'subjectExternalId', band: 'band' } },
  'case.report_attached': { target: ['case', 'caseId'], facts: { report_id: 'reportId' } },
  'case.classified': {
    target: ['case', 'caseId'],
    facts: { category_id: 'categoryId', signals: 'signals', injection_suspected: 'injectionSuspected', pre_rule_p0: 'preRuleP0', classified_by: 'classifiedBy', custom_category_id: 'customCategoryId', rules_reason: 'rulesReason' },
  },
  'case.reclassified': {
    target: ['case', 'caseId'],
    facts: { category_id: 'categoryId', signals: 'signals', injection_suspected: 'injectionSuspected', pre_rule_p0: 'preRuleP0', classified_by: 'classifiedBy', custom_category_id: 'customCategoryId' },
  },
  'case.triaged': {
    target: ['case', 'caseId'],
    facts: {
      report_ids: 'reportIds',
      category_id: 'categoryId',
      custom_category_id: 'customCategoryId',
      severity: 'severity',
      priority: 'priority',
      sla_due_at: 'slaDueAt',
      suggested_action_keys: 'suggestedActionKeys',
      applied_rules: 'applied',
      flags: 'flags',
      signals: 'signals',
      injection_suspected: 'injectionSuspected',
      classified_by: 'classifiedBy',
    },
  },
  'case.untriaged': { target: ['case', 'caseId'], facts: { reason: 'reason' } },
  'case.claimed': { target: ['case', 'caseId'], facts: { holder: 'memberId' } },
  'case.released': { target: ['case', 'caseId'], facts: { holder: 'memberId', reason: 'reason' } },
  'case.decided': {
    target: ['case', 'caseId'],
    facts: {
      decision_id: 'decisionId',
      subject_external_id: 'subjectExternalId',
      outcome: 'outcome',
      category_id: 'categoryId',
      severity: 'severity',
      action_keys: 'actionKeys',
      report_ids: 'reportIds',
      decided_by: 'decidedBy',
    },
  },
  'case.corrected': { target: ['case', 'caseId'], facts: { before: 'before', after: 'after', corrected_by: 'correctedBy' } },
  'case.actions_retried': {
    target: ['case', 'caseId'],
    facts: { decision_id: 'decisionId', action_keys: 'actionKeys', retried_by: 'retriedBy' },
  },
  'action.requested': {
    target: ['action_request', 'actionRequestId'],
    facts: {
      case_id: 'caseId',
      decision_id: 'decisionId',
      action_key: 'actionKey',
      subject_external_id: 'subjectExternalId',
      reason: 'reason',
      requested_by: 'requestedBy',
      replaces: 'replaces',
    },
  },
  'action.confirmed': { target: ['action_request', 'actionRequestId'], facts: { case_id: 'caseId' } },
  'action.failed': { target: ['action_request', 'actionRequestId'], facts: { case_id: 'caseId' } },
  'decision.actions_confirmed': { target: ['case', 'caseId'], facts: { decision_id: 'decisionId' } },
  'config.action_keys_replaced': { target: ['app', 'appId'], facts: { before: 'before', after: 'after' } },
  'config.categories_replaced': { target: ['app', 'appId'], facts: { before: 'before', after: 'after' } },
  'config.llm_settings_changed': { target: ['app', 'appId'], facts: { before: 'before', after: 'after' } },
  'api_key.issued': { target: ['api_key', 'keyId'], facts: { scopes: 'scopes' } },
  'api_key.rotated': { target: ['api_key', 'keyId'], facts: { replaced_by: 'replacedBy', expires_at: 'expiresAt' } },
  'api_key.revoked': { target: ['api_key', 'keyId'], facts: {} },
  'app.created': { target: ['app', 'appId'], facts: { name: 'name' } },
  'app.deletion_requested': { target: ['app', 'appId'], facts: { purge_at: 'purgeAt' } },
  'app.restored': { target: ['app', 'appId'], facts: {} },
}

/** The event types the audit log records. */
export const AUDITED_EVENT_TYPES: readonly string[] = Object.keys(SPECS)

/**
 * The entry for an event, or null for a type the log does not record:
 * - action: the event type; target: the spec'd type and id from the data
 * - actor: the request's actor when the event was published during an API request, else system
 * - at: the event's `occurredAt`, else when it was published, else `now`
 * - facts: the spec'd data fields that are present (renamed to snake_case), plus `request_id`
 * - found by: the case (the target, or the `caseId` field) and `subjectExternalId`, when present
 */
export function auditRecordOf(event: RecordedEvent, now: Date): AuditRecord | null {
  const spec = SPECS[event.type]
  if (!spec) return null
  const data = (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>
  const [targetType, targetField] = spec.target
  const targetId = data[targetField]
  if (typeof targetId !== 'string' || targetId === '') throw new Error(`Event ${event.id} (${event.type}) has no ${targetField}`)

  const facts: Record<string, Json> = {}
  for (const [name, field] of Object.entries(spec.facts)) {
    const value = data[field]
    if (value !== undefined) facts[name] = toJson(value)
  }
  if (event.meta?.requestId) facts.request_id = event.meta.requestId

  // A string once the event went through JSON (the Postgres bus), a Date on the memory bus.
  const occurredAt = typeof data.occurredAt === 'string' || data.occurredAt instanceof Date ? new Date(data.occurredAt) : null
  const at = occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : (event.meta?.publishedAt ?? now)
  const actor = event.meta?.actor ? { type: event.meta.actor.type, id: event.meta.actor.id } : SYSTEM_ACTOR
  const caseId = targetType === 'case' ? targetId : typeof data.caseId === 'string' ? data.caseId : null
  const subject = typeof data.subjectExternalId === 'string' ? data.subjectExternalId : null

  return { input: { at, actor, action: event.type, target: { type: targetType, id: targetId }, facts }, caseId, subjectExternalId: subject }
}

/** Event data is JSON already; this only drops what canonical JSON cannot hold. */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}
