// Action requests: one per action key of a decision, settled by the tenant (confirmed or failed).
// Delivery owns them, so it also tells the other modules when every action of a decision is done.

import { FlagwiseError, type AppRef } from '@flagwise/kernel'

export interface ActionRequest {
  readonly id: string
  readonly appRef: AppRef
  readonly caseId: string
  readonly decisionId: string
  readonly actionKey: string
  readonly status: 'pending' | 'confirmed' | 'failed'
  readonly failReason: string | null
  /** The retry that made it, or null for a decision's own requests. */
  readonly retryId: string | null
  /** A failed request answered by a retry: that retry's id. It no longer counts for the decision. */
  readonly replacedBy: string | null
}

/** Every method only sees requests of the given app and mode. */
export interface ActionRequestStore {
  findById(appRef: AppRef, id: string): Promise<ActionRequest | null>
  /** The decision's requests, in the order they were inserted. */
  findByDecision(appRef: AppRef, decisionId: string): Promise<readonly ActionRequest[]>
  /** Until the current transaction ends, another caller locking the same decision waits. */
  lockDecision(appRef: AppRef, decisionId: string): Promise<void>
  insert(request: ActionRequest): Promise<void>
  /** Saves the status, failReason and replacedBy of an existing request. */
  update(request: ActionRequest): Promise<void>
}

export type DeliveryEvent =
  | {
      readonly type: 'action.requested'
      readonly appRef: AppRef
      readonly actionRequestId: string
      readonly caseId: string
      readonly actionKey: string
      /** The facts the action.requested webhook carries. */
      readonly decisionId: string
      readonly subjectExternalId: string
      readonly categoryId: string
      readonly severity: 'P0' | 'P1' | 'P2'
      readonly reason: 'decision'
      readonly requestedBy: RequestedBy
      /** The failed requests this one answers, when a moderator retried failed actions. */
      readonly replaces?: readonly string[]
    }
  | {
      readonly type: 'action.confirmed' | 'action.failed'
      readonly appRef: AppRef
      readonly actionRequestId: string
      readonly caseId: string
    }
  | {
      /** Every action request of the decision is confirmed. */
      readonly type: 'decision.actions_confirmed'
      readonly appRef: AppRef
      readonly caseId: string
      readonly decisionId: string
    }

export interface DeliveryDeps {
  readonly requests: ActionRequestStore
  readonly events: { publish(event: DeliveryEvent): Promise<void> }
  readonly newActionRequestId: () => string
}

/** Who asked for an action: a dashboard member, an API key, or Flagwise itself. */
export interface RequestedBy {
  readonly type: 'member' | 'api_key' | 'system'
  readonly id: string
}

export interface DecisionToDeliver {
  readonly appRef: AppRef
  readonly caseId: string
  readonly decisionId: string
  readonly actionKeys: readonly string[]
  readonly subjectExternalId: string
  readonly categoryId: string
  readonly severity: 'P0' | 'P1' | 'P2'
  readonly requestedBy: RequestedBy
}

/**
 * Creates one pending request per action key of the decision, in order, and publishes
 * action.requested for each, with the decision's facts and reason 'decision'; returns the
 * decision's requests. When the decision already has
 * requests (a redelivery), returns them and writes and publishes nothing.
 */
export async function requestActions(deps: DeliveryDeps, decision: DecisionToDeliver): Promise<readonly ActionRequest[]> {
  const { appRef, caseId, decisionId, subjectExternalId, categoryId, severity, requestedBy } = decision
  await deps.requests.lockDecision(appRef, decisionId)
  const existing = await deps.requests.findByDecision(appRef, decisionId)
  if (existing.length > 0) return existing
  const created: ActionRequest[] = decision.actionKeys.map((actionKey) => ({
    id: deps.newActionRequestId(),
    appRef,
    caseId,
    decisionId,
    actionKey,
    status: 'pending',
    failReason: null,
    retryId: null,
    replacedBy: null,
  }))
  for (const r of created) await deps.requests.insert(r)
  for (const r of created) {
    await deps.events.publish({
      type: 'action.requested',
      appRef,
      actionRequestId: r.id,
      caseId,
      actionKey: r.actionKey,
      decisionId,
      subjectExternalId,
      categoryId,
      severity,
      reason: 'decision',
      requestedBy,
    })
  }
  return created
}

export interface SettleAction {
  readonly appRef: AppRef
  readonly actionRequestId: string
  readonly status: 'confirmed' | 'failed'
  /** Required in practice for 'failed'; ignored for 'confirmed'. */
  readonly failReason?: string
}

/**
 * Settles a pending request and publishes action.confirmed or action.failed. When that confirms
 * the last pending request of the decision and every request is confirmed (replaced ones aside), also publishes
 * decision.actions_confirmed. Requests of one decision are settled one at a time, so two
 * confirmations at once still publish it exactly once. A request that is not pending is left
 * alone. An unknown id throws FlagwiseError 'not_found'.
 */
export async function settleAction(deps: DeliveryDeps, input: SettleAction): Promise<void> {
  const { appRef, actionRequestId, status } = input
  const found = await deps.requests.findById(appRef, actionRequestId)
  if (!found) throw new FlagwiseError('not_found', `No action request ${actionRequestId}`)
  await deps.requests.lockDecision(appRef, found.decisionId)
  const request = (await deps.requests.findById(appRef, actionRequestId))!
  if (request.status !== 'pending') return
  await deps.requests.update({ ...request, status, failReason: status === 'failed' ? (input.failReason ?? '') : null })
  await deps.events.publish({ type: `action.${status}`, appRef, actionRequestId, caseId: request.caseId })
  if (status === 'confirmed') await publishIfAllConfirmed(deps, appRef, request.caseId, request.decisionId)
}

async function publishIfAllConfirmed(deps: DeliveryDeps, appRef: AppRef, caseId: string, decisionId: string): Promise<void> {
  const all = await deps.requests.findByDecision(appRef, decisionId)
  if (all.every((r) => r.replacedBy !== null || r.status === 'confirmed')) {
    await deps.events.publish({ type: 'decision.actions_confirmed', appRef, caseId, decisionId })
  }
}

export interface ActionRetry extends DecisionToDeliver {
  /** The retry's own id, unique per retry. */
  readonly retryId: string
  /** The failed requests the retry answers; default every failed request not replaced yet. */
  readonly replaces?: readonly string[]
}

/**
 * Answers failed requests of a decision (from case.actions_retried): marks the failed requests in
 * `replaces` that are not replaced yet (every such request when `replaces` is not given) as
 * replaced by this retry, then creates one pending request per action key after the decision's
 * existing ones and publishes action.requested for each, with `replaces` naming the replaced
 * requests. When the decision's requests, replaced ones aside, are then all confirmed (e.g. an
 * empty retry), publishes decision.actions_confirmed. Returns the new requests. A retry already
 * carried out (a redelivery) writes and publishes nothing and returns [].
 */
export async function retryFailedActions(deps: DeliveryDeps, retry: ActionRetry): Promise<readonly ActionRequest[]> {
  const { appRef, caseId, decisionId, retryId } = retry
  await deps.requests.lockDecision(appRef, decisionId)
  const existing = await deps.requests.findByDecision(appRef, decisionId)
  if (existing.some((r) => r.retryId === retryId || r.replacedBy === retryId)) return []
  const replaced = existing.filter((r) => r.status === 'failed' && r.replacedBy === null && (retry.replaces === undefined || retry.replaces.includes(r.id)))
  for (const r of replaced) await deps.requests.update({ ...r, replacedBy: retryId })
  const created: ActionRequest[] = retry.actionKeys.map((actionKey) => ({
    id: deps.newActionRequestId(),
    appRef,
    caseId,
    decisionId,
    actionKey,
    status: 'pending',
    failReason: null,
    retryId,
    replacedBy: null,
  }))
  for (const r of created) await deps.requests.insert(r)
  for (const r of created) {
    await deps.events.publish({
      type: 'action.requested',
      appRef,
      actionRequestId: r.id,
      caseId,
      actionKey: r.actionKey,
      decisionId,
      subjectExternalId: retry.subjectExternalId,
      categoryId: retry.categoryId,
      severity: retry.severity,
      reason: 'decision',
      requestedBy: retry.requestedBy,
      replaces: replaced.map((x) => x.id),
    })
  }
  if (created.length === 0) await publishIfAllConfirmed(deps, appRef, caseId, decisionId)
  return created
}
