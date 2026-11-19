// The action request routes: the tenant's backend reads a request before carrying out its action,
// then confirms it or reports a failure. The edge authenticates and sets the caller; these
// routes authorize from it and call the use cases.

import { can, FlagwiseError, type Caller, type AppRef } from '@flagwise/kernel'
import { Hono, type Context } from 'hono'
import type { ActionRequest, ActionRequestStore } from '../app/action-requests.ts'

export interface ActionRequestsEnv {
  Variables: { caller: Caller }
}

export interface ActionRequestRoutesDeps {
  /** Runs `fn` in an app transaction. */
  read<T>(appRef: AppRef, fn: (requests: ActionRequestStore) => Promise<T>): Promise<T>
  /** settleAction, with its events published in the same transaction. */
  confirm(appRef: AppRef, actionRequestId: string): Promise<void>
  fail(appRef: AppRef, actionRequestId: string, reason: string): Promise<void>
}

const MAX_REASON = 500

/**
 * For API keys with the `actions` scope ('forbidden' otherwise):
 *
 * - `GET /delivery/action-requests/:id`: the request, or 'not_found'. The tenant carries out an action only
 *   while its request is `pending`.
 * - `POST /delivery/action-requests/:id/confirm`: the action ran; the request after the change.
 * - `POST /delivery/action-requests/:id/fail` with `{ "reason": "..." }` (1 to 500 characters): it could not
 *   run; the request after the change.
 *
 * Answering again with the same outcome is harmless and returns the request. Answering a request
 * already settled the other way (or cancelled) is 'conflict', naming its status.
 *
 * Body: `{ object: 'action_request', id, status, action_key, case_id, decision_id, fail_reason }`.
 */
export function deliveryRoutes(deps: ActionRequestRoutesDeps): Hono<ActionRequestsEnv> {
  const routes = new Hono<ActionRequestsEnv>().basePath('/delivery')
  const find = async (appRef: AppRef, id: string) => {
    const request = await deps.read(appRef, (requests) => requests.findById(appRef, id))
    if (!request) throw new FlagwiseError('not_found', 'No such action request')
    return request
  }
  const settled = async (appRef: AppRef, id: string, wanted: ActionRequest['status']) => {
    const request = await find(appRef, id)
    if (request.status !== wanted) throw new FlagwiseError('conflict', `The action request is already ${request.status}`)
    return request
  }

  routes.get('/action-requests/:id', async (c) => c.json(body(await find(responder(c.get('caller')), c.req.param('id')))))

  routes.post('/action-requests/:id/confirm', async (c) => {
    const appRef = responder(c.get('caller'))
    const id = c.req.param('id')
    await settling(() => deps.confirm(appRef, id))
    return c.json(body(await settled(appRef, id, 'confirmed')))
  })

  routes.post('/action-requests/:id/fail', async (c) => {
    const appRef = responder(c.get('caller'))
    const id = c.req.param('id')
    const reason = await failReason(c)
    await settling(() => deps.fail(appRef, id, reason))
    return c.json(body(await settled(appRef, id, 'failed')))
  })

  return routes
}

/** The app and mode of a caller allowed to answer action requests. */
function responder(ctx: Caller): AppRef {
  if (!ctx.appId || !can(ctx, { action: 'action_request.respond', appId: ctx.appId })) {
    throw new FlagwiseError('forbidden', 'This API key does not have the actions scope')
  }
  return { appId: ctx.appId, livemode: ctx.livemode }
}

/** settleAction's unknown id becomes the API's not_found. */
async function settling(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    if (err instanceof FlagwiseError && err.code === 'not_found') throw new FlagwiseError('not_found', 'No such action request')
    throw err
  }
}

async function failReason(c: Context): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await c.req.text())
  } catch {
    throw new FlagwiseError('invalid_request', 'The body is not valid JSON')
  }
  const reason = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).reason : undefined
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_REASON) {
    throw new FlagwiseError('validation_failed', 'Say why the action failed', { errors: [{ path: 'reason', message: `Text of 1 to ${MAX_REASON} characters` }] })
  }
  return reason
}

function body(r: ActionRequest) {
  return {
    object: 'action_request',
    id: r.id,
    status: r.status,
    action_key: r.actionKey,
    case_id: r.caseId,
    decision_id: r.decisionId,
    fail_reason: r.failReason,
  }
}
