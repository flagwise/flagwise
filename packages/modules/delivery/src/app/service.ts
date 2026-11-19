// Delivery as a service: settling action requests, each in one transaction of its own with its
// events, and its reactions on the bus, reading and writing only its own tables.

import { currentType, type EventData } from '@flagwise/contracts'
import type { Clock, TenantRef } from '@flagwise/kernel'
import { tenantOf, type BusEvent, type EventBus, type UnitOfWork, type Work } from '@flagwise/platform'
import type { InternalEvent } from '../domain/webhooks.ts'
import { requestActions, retryFailedActions, settleAction, type ActionRequestStore, type DeliveryDeps, type DeliveryEvent, type RequestedBy } from './action-requests.ts'
import { enqueueWebhook, type WebhookStore } from './webhooks.ts'

export interface DeliveryStores {
  readonly requests: ActionRequestStore
  readonly webhooks: WebhookStore
}

export interface DeliveryServiceDeps {
  readonly uow: UnitOfWork<DeliveryStores>
  readonly clock: Clock
  readonly newActionRequestId: () => string
  /** Ids of webhook events. */
  readonly newEventId: () => string
}

export interface ActionSettlement {
  confirm(tenant: TenantRef, actionRequestId: string): Promise<void>
  fail(tenant: TenantRef, actionRequestId: string, reason: string): Promise<void>
}

const workOf = (deps: DeliveryServiceDeps, w: Work<DeliveryStores>): DeliveryDeps => ({
  requests: w.stores.requests,
  newActionRequestId: deps.newActionRequestId,
  events: {
    async publish(event: DeliveryEvent) {
      const { type, tenant: _tenant, ...data } = event
      const id = type === 'decision.actions_confirmed' ? `${type}:${event.decisionId}` : `${type}:${event.actionRequestId}`
      await w.publish({ id, type: currentType(type), key: event.caseId, data })
    },
  },
})

/** settleAction for the tenant's answers, each in one transaction with its events; an unknown id throws. */
export function actionSettlement(deps: DeliveryServiceDeps): ActionSettlement {
  return {
    confirm: (tenant, id) => deps.uow.run(tenant, (w) => settleAction(workOf(deps, w), { tenant, actionRequestId: id, status: 'confirmed' })),
    fail: (tenant, id, reason) => deps.uow.run(tenant, (w) => settleAction(workOf(deps, w), { tenant, actionRequestId: id, status: 'failed', failReason: reason })),
  }
}

/**
 * Subscribes delivery's groups (event -> effect):
 * - 'delivery': case.decided -> requestActions: one pending request per action key, in order, and
 *   action.requested for each; nothing when the decision already has requests.
 *   case.actions_retried -> retryFailedActions for the requests it names (its id is the retry's),
 *   with the retrier as `requested_by`; nothing when that retry was carried out already.
 * - 'delivery.webhooks': case.triaged and case.retriaged (as report.triaged), case.untriaged and
 *   action.requested -> enqueueWebhook for the app's endpoints, keyed by the event's id. A
 *   case.triaged after the LLM answered sends none: its case.retriaged does, once moderation has
 *   taken it, so a case a moderator claimed meanwhile sends nothing. One caused by a moderator's
 *   correction sends none either: the tenant hears of the case again at its decision.
 * The decider of an action becomes its `requested_by`: an API key (`key_` ids), Flagwise itself
 * (`system`), else a member.
 */
export function subscribeDelivery(bus: EventBus, deps: DeliveryServiceDeps): void {
  bus.subscribe('delivery', ['case.decided.v1', 'case.actions_retried.v1'], async (event) => {
    const tenant = tenantOf(event)
    if (event.type === 'case.decided.v1') {
      const d = event.data as EventData<'case.decided.v1'>
      await deps.uow.run(tenant, (w) =>
        requestActions(workOf(deps, w), {
          tenant,
          caseId: d.caseId,
          decisionId: d.decisionId,
          actionKeys: d.actionKeys,
          subjectExternalId: d.subjectExternalId,
          categoryId: d.categoryId,
          severity: d.severity,
          requestedBy: requesterOf(d.decidedBy),
        }),
      )
      return
    }
    const r = event.data as EventData<'case.actions_retried.v1'>
    await deps.uow.run(tenant, (w) =>
      retryFailedActions(workOf(deps, w), {
        tenant,
        caseId: r.caseId,
        decisionId: r.decisionId,
        actionKeys: r.actionKeys,
        subjectExternalId: r.subjectExternalId,
        categoryId: r.categoryId,
        severity: r.severity,
        requestedBy: requesterOf(r.retriedBy),
        retryId: event.id,
        ...(r.replaces && { replaces: r.replaces }),
      }),
    )
  })

  bus.subscribe('delivery.webhooks', ['case.triaged.v1', 'case.retriaged.v1', 'case.untriaged.v1', 'action.requested.v1'], async (event) => {
    const cause = event.type === 'case.triaged.v1' ? (event.data as EventData<'case.triaged.v1'>).cause : undefined
    if (cause === 'correction' || cause === 'llm_retry') return
    const tenant = tenantOf(event)
    await deps.uow.run(tenant, (w) => enqueueWebhook({ webhooks: w.stores.webhooks, clock: deps.clock, newEventId: deps.newEventId }, tenant, { sourceId: event.id, event: webhookEventOf(event) }))
  })
}

/** Who asked for a decision's actions, from the decider's id. */
function requesterOf(decidedBy: string): RequestedBy {
  if (decidedBy === 'system') return { type: 'system', id: 'system' }
  return { type: decidedBy.startsWith('key_') ? 'api_key' : 'member', id: decidedBy }
}

/** The webhook-side view of a case.triaged, case.retriaged, case.untriaged or action.requested bus event. */
function webhookEventOf(event: BusEvent): InternalEvent {
  if (event.type === 'case.untriaged.v1') {
    const d = event.data as EventData<'case.untriaged.v1'>
    return { type: 'case.untriaged', caseId: d.caseId, reason: d.reason }
  }
  if (event.type === 'case.triaged.v1' || event.type === 'case.retriaged.v1') {
    const d = event.data as EventData<'case.retriaged.v1'>
    return {
      type: 'case.triaged',
      caseId: d.caseId,
      reportIds: d.reportIds,
      categoryId: d.categoryId,
      customCategoryId: d.customCategoryId ?? null,
      severity: d.severity,
      priority: d.priority,
      slaDueAt: new Date(d.slaDueAt),
      suggestedActionKeys: d.suggestedActionKeys,
      signals: d.signals,
      injectionSuspected: d.injectionSuspected,
      classifiedBy: d.classifiedBy,
    }
  }
  const d = event.data as EventData<'action.requested.v1'>
  return {
    type: 'action.requested',
    actionRequestId: d.actionRequestId,
    actionKey: d.actionKey,
    subjectExternalId: d.subjectExternalId,
    caseId: d.caseId,
    decisionId: d.decisionId,
    categoryId: d.categoryId,
    severity: d.severity,
    reason: d.reason,
    requestedBy: d.requestedBy,
  }
}
