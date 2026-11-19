// Turning internal events into tenant webhooks.

export type Severity = 'P0' | 'P1' | 'P2'

export type InternalEvent =
  | {
      readonly type: 'case.triaged'
      readonly caseId: string
      readonly reportIds: readonly string[]
      readonly categoryId: string
      readonly customCategoryId?: string | null
      readonly severity: Severity
      readonly priority: number
      readonly slaDueAt: Date
      readonly suggestedActionKeys: readonly string[]
      readonly signals: readonly string[]
      readonly injectionSuspected: boolean
      readonly classifiedBy: 'llm' | 'rules'
      /** LLM summary of the reported content: internal only. */
      readonly summary?: string
    }
  | { readonly type: 'case.untriaged'; readonly caseId: string; readonly reason: 'no_credit' | 'provider_error' | 'budget_cap' }
  | {
      readonly type: 'action.requested'
      readonly actionRequestId: string
      readonly actionKey: string
      readonly subjectExternalId: string
      readonly caseId?: string | null
      readonly decisionId?: string | null
      readonly categoryId?: string | null
      readonly severity?: Severity | null
      readonly reason: 'decision' | 'threshold' | 'appeal_reversal'
      readonly requestedBy: { readonly type: 'member' | 'api_key' | 'system'; readonly id: string }
    }
  | {
      readonly type: 'account.threshold_crossed'
      readonly subjectExternalId: string
      readonly score: number
      readonly threshold: number
      readonly actionKey: string
      readonly autoRequested: boolean
    }
  | {
      readonly type: 'decision.notice'
      readonly decisionId: string
      readonly recipient: 'reported' | 'reporter'
      readonly subjectExternalId: string
      readonly locale: 'en' | 'id'
      readonly text: string
      readonly appealUrl?: string | null
      readonly appealDeadline?: Date | null
      /** The recipient's email in managed mode: never sent to the tenant. */
      readonly email?: string
    }
  | { readonly type: 'appeal.filed'; readonly appealId: string; readonly decisionId: string; readonly appellant: 'reported' | 'reporter'; readonly text?: string }
  | { readonly type: 'appeal.resolved'; readonly appealId: string; readonly outcome: 'upheld' | 'overturned'; readonly reverseActionRequestIds: readonly string[] }
  | {
      readonly type: 'identifier.matched'
      readonly subjectExternalId: string
      readonly matchedExternalId: string
      readonly priorScore: number
      readonly categories: readonly string[]
      readonly crossApp: boolean
    }
  | { readonly type: 'subject.erased'; readonly erasureId: string; readonly subjectExternalId: string; readonly heldItems: number }
  | { readonly type: 'case.opened' | 'case.claimed' | 'case.released'; readonly caseId: string }

export interface WebhookContext {
  readonly eventId: string
  readonly apiVersion: string
  readonly createdAt: Date
  readonly livemode: boolean
  readonly appId: string
}

export interface WebhookBody {
  readonly id: string
  readonly type: string
  readonly api_version: string
  readonly created_at: string
  readonly livemode: boolean
  readonly app_id: string
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * The webhook body for an internal event, or null for events appRefs never see (case.opened,
 * case.claimed, case.released and any other type not listed).
 *
 * Envelope: `{ id: ctx.eventId, type, api_version: ctx.apiVersion, created_at: ISO of
 * ctx.createdAt, livemode, app_id, data }`. `ctx.eventId` must start with `evt_` and
 * `ctx.apiVersion` look like YYYY-MM-DD, else RangeError.
 *
 * `data` has snake_case keys, Dates as ISO strings, and only these fields, in this order. Internal
 * fields not listed (the LLM summary, report text, the recipient's email) are never copied.
 *
 *     case.triaged -> report.triaged: case_id, report_ids, category_id, custom_category_id (null
 *       when none), severity, priority, sla_due_at, suggested_action_keys, signals,
 *       injection_suspected, classified_by
 *     case.untriaged: case_id, reason
 *     action.requested: action_request_id, action_key, subject_external_id, case_id (null for a
 *       threshold action), decision_id, category_id,
 *       severity (each null when none), reason, requested_by { type, id }
 *     account.threshold_crossed: subject_external_id, score, threshold, action_key, auto_requested
 *     decision.notice: decision_id, recipient, subject_external_id, locale, text, appeal_url (null
 *       in webhook mode), appeal_deadline (null in managed mode). The only webhook with end-user
 *       text, because the tenant must deliver it.
 *     appeal.filed: appeal_id, decision_id, appellant
 *     appeal.resolved: appeal_id, outcome, reverse_action_request_ids
 *     identifier.matched: subject_external_id, matched_external_id, prior_score, categories, cross_app
 *     subject.erased: erasure_id, subject_external_id, held_items
 */
export function toWebhook(event: InternalEvent, ctx: WebhookContext): WebhookBody | null {
  if (!ctx.eventId.startsWith('evt_')) throw new RangeError('eventId must start with evt_')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.apiVersion)) throw new RangeError('apiVersion must look like YYYY-MM-DD')
  const mapped = mapEvent(event)
  if (!mapped) return null
  return {
    id: ctx.eventId,
    type: mapped.type,
    api_version: ctx.apiVersion,
    created_at: ctx.createdAt.toISOString(),
    livemode: ctx.livemode,
    app_id: ctx.appId,
    data: mapped.data,
  }
}

/** An endpoint's event-type filter: null or an empty list means all types; otherwise the type must be listed. */
export function matchesFilter(type: string, filter: readonly string[] | null): boolean {
  return filter === null || filter.length === 0 || filter.includes(type)
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null)

function mapEvent(event: InternalEvent): { type: string; data: Record<string, unknown> } | null {
  switch (event.type) {
    case 'case.triaged':
      return {
        type: 'report.triaged',
        data: {
          case_id: event.caseId,
          report_ids: event.reportIds,
          category_id: event.categoryId,
          custom_category_id: event.customCategoryId ?? null,
          severity: event.severity,
          priority: event.priority,
          sla_due_at: event.slaDueAt.toISOString(),
          suggested_action_keys: event.suggestedActionKeys,
          signals: event.signals,
          injection_suspected: event.injectionSuspected,
          classified_by: event.classifiedBy,
        },
      }
    case 'case.untriaged':
      return { type: event.type, data: { case_id: event.caseId, reason: event.reason } }
    case 'action.requested': {
      const caseId = event.caseId ?? null
      return {
        type: event.type,
        data: {
          action_request_id: event.actionRequestId,
          action_key: event.actionKey,
          subject_external_id: event.subjectExternalId,
          case_id: caseId,
          decision_id: event.decisionId ?? null,
          category_id: event.categoryId ?? null,
          severity: event.severity ?? null,
          reason: event.reason,
          requested_by: { type: event.requestedBy.type, id: event.requestedBy.id },
        },
      }
    }
    case 'account.threshold_crossed':
      return {
        type: event.type,
        data: {
          subject_external_id: event.subjectExternalId,
          score: event.score,
          threshold: event.threshold,
          action_key: event.actionKey,
          auto_requested: event.autoRequested,
        },
      }
    case 'decision.notice':
      return {
        type: event.type,
        data: {
          decision_id: event.decisionId,
          recipient: event.recipient,
          subject_external_id: event.subjectExternalId,
          locale: event.locale,
          text: event.text,
          appeal_url: event.appealUrl ?? null,
          appeal_deadline: iso(event.appealDeadline),
        },
      }
    case 'appeal.filed':
      return { type: event.type, data: { appeal_id: event.appealId, decision_id: event.decisionId, appellant: event.appellant } }
    case 'appeal.resolved':
      return {
        type: event.type,
        data: { appeal_id: event.appealId, outcome: event.outcome, reverse_action_request_ids: event.reverseActionRequestIds },
      }
    case 'identifier.matched':
      return {
        type: event.type,
        data: {
          subject_external_id: event.subjectExternalId,
          matched_external_id: event.matchedExternalId,
          prior_score: event.priorScore,
          categories: event.categories,
          cross_app: event.crossApp,
        },
      }
    case 'subject.erased':
      return {
        type: event.type,
        data: { erasure_id: event.erasureId, subject_external_id: event.subjectExternalId, held_items: event.heldItems },
      }
    default:
      return null
  }
}
