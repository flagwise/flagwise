// Delivery as a service: settling action requests, each in one transaction of its own with its
// events, and its reactions on the bus, reading and writing only its own tables.

import { currentType, erasedId, erasureAnswer, notificationCleared, notificationRaised, type EventData } from '@flagwise/contracts'
import type { Clock, AppRef } from '@flagwise/kernel'
import { appOf, type BusEvent, type EventBus, type Scheduler, type Timers, type UnitOfWork, type Work } from '@flagwise/platform'
import type { InternalEvent } from '../domain/webhooks.ts'
import { requestActions, retryFailedActions, settleAction, type ActionRequestStore, type DeliveryDeps, type DeliveryEvent, type RequestedBy } from './action-requests.ts'
import { enqueueWebhook, type WebhookStore } from './webhooks.ts'

export interface DeliveryStores {
  readonly requests: ActionRequestStore
  readonly webhooks: WebhookStore
  /** Delivery's timers: each pending action request's deadline. */
  readonly timers: Timers
}

/** How long the app's systems have to answer an action request before people hear of it. */
export const ACTION_ANSWER_MS = 24 * 3_600_000

export interface DeliveryServiceDeps {
  readonly uow: UnitOfWork<DeliveryStores>
  readonly clock: Clock
  readonly newActionRequestId: () => string
  /** Ids of webhook events. */
  readonly newEventId: () => string
}

export interface ActionSettlement {
  confirm(appRef: AppRef, actionRequestId: string): Promise<void>
  fail(appRef: AppRef, actionRequestId: string, reason: string): Promise<void>
}

const workOf = (deps: DeliveryServiceDeps, w: Work<DeliveryStores>): DeliveryDeps => ({
  requests: w.stores.requests,
  newActionRequestId: deps.newActionRequestId,
  events: {
    async publish(event: DeliveryEvent) {
      const { type, appRef: _appRef, ...data } = event
      const id = type === 'decision.actions_confirmed' ? `${type}:${event.decisionId}` : `${type}:${event.actionRequestId}`
      await w.publish({ id, type: currentType(type), key: event.caseId, data })
      // A request waits for its answer for ACTION_ANSWER_MS; an answer after that clears action_overdue.
      const timers = w.stores.timers
      if (event.type === 'action.requested') {
        await timers.set(event.appRef, `action_overdue:${event.actionRequestId}`, new Date(deps.clock.now().getTime() + ACTION_ANSWER_MS), { actionRequestId: event.actionRequestId })
      } else if (event.type !== 'decision.actions_confirmed' && !(await timers.cancel(event.appRef, `action_overdue:${event.actionRequestId}`))) {
        await w.publish(notificationCleared('action_overdue', event.actionRequestId, event.type, deps.clock.now()))
      }
    },
  },
})

/** settleAction for the tenant's answers, each in one transaction with its events; an unknown id throws. */
export function actionSettlement(deps: DeliveryServiceDeps): ActionSettlement {
  return {
    confirm: (appRef, id) => deps.uow.run(appRef, (w) => settleAction(workOf(deps, w), { appRef, actionRequestId: id, status: 'confirmed' })),
    fail: (appRef, id, reason) => deps.uow.run(appRef, (w) => settleAction(workOf(deps, w), { appRef, actionRequestId: id, status: 'failed', failReason: reason })),
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
 *   erasure.completed -> subject.erased.
 * - Timers of 'delivery': an action request still pending ACTION_ANSWER_MS after it was made ->
 *   action_overdue; its answer (confirmed or failed) clears it.
 * - 'delivery.erasure': subject.erasure_requested -> the account's id replaced in the webhook
 *   bodies that name it (action requests keep no account id); answers erased, or nothing_held.
 * The decider of an action becomes its `requested_by`: an API key (`key_` ids), Flagwise itself
 * (`system`), else a member.
 */
export function subscribeDelivery(bus: EventBus, deps: DeliveryServiceDeps, scheduler: Scheduler): void {
  scheduler.on('delivery', async (timer) => {
    const id = timer.data['actionRequestId']
    if (!id) return
    await deps.uow.run(timer.appRef, async (w) => {
      const request = await w.stores.requests.findById(timer.appRef, id)
      if (request?.status !== 'pending') return
      await w.publish(notificationRaised('action_overdue', id, { actionRequestId: id, caseId: request.caseId, actionKey: request.actionKey }, deps.clock.now()))
    })
  })

  bus.subscribe('delivery', ['case.decided.v1', 'case.actions_retried.v1'], async (event) => {
    const appRef = appOf(event)
    if (event.type === 'case.decided.v1') {
      const d = event.data as EventData<'case.decided.v1'>
      await deps.uow.run(appRef, (w) =>
        requestActions(workOf(deps, w), {
          appRef,
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
    await deps.uow.run(appRef, (w) =>
      retryFailedActions(workOf(deps, w), {
        appRef,
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

  bus.subscribe('delivery.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const appRef = appOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await deps.uow.run(appRef, async (w) => {
      const had = await w.stores.webhooks.eraseAccount(appRef, request.subjectExternalId, erasedId(request.erasureId))
      await w.publish(erasureAnswer(request, 'delivery.erasure', had > 0 ? 'erased' : 'nothing_held', deps.clock.now()))
    })
  })

  bus.subscribe('delivery.webhooks', ['case.triaged.v1', 'case.retriaged.v1', 'case.untriaged.v1', 'action.requested.v1', 'erasure.completed.v1'], async (event) => {
    const cause = event.type === 'case.triaged.v1' ? (event.data as EventData<'case.triaged.v1'>).cause : undefined
    if (cause === 'correction' || cause === 'llm_retry') return
    const appRef = appOf(event)
    await deps.uow.run(appRef, (w) => enqueueWebhook({ webhooks: w.stores.webhooks, clock: deps.clock, newEventId: deps.newEventId }, appRef, { sourceId: event.id, event: webhookEventOf(event) }))
  })
}

/** Who asked for a decision's actions, from the decider's id. */
function requesterOf(decidedBy: string): RequestedBy {
  if (decidedBy === 'system') return { type: 'system', id: 'system' }
  return { type: decidedBy.startsWith('key_') ? 'api_key' : 'member', id: decidedBy }
}

/** The webhook-side view of a case.triaged, case.retriaged, case.untriaged or action.requested bus event. */
function webhookEventOf(event: BusEvent): InternalEvent {
  if (event.type === 'erasure.completed.v1') {
    const d = event.data as EventData<'erasure.completed.v1'>
    return { type: 'subject.erased', erasureId: d.erasureId, subjectExternalId: d.subjectExternalId, heldItems: d.heldItems }
  }
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
