// The notifications routes. The edge authenticates and sets the caller; these routes authorize
// from it and call the use cases.

import { can, FlagwiseError, type AppRef, type Caller } from '@flagwise/kernel'
import { Hono } from 'hono'
import type { NotificationsService } from '../app/service.ts'
import type { NotificationRecord, NotificationState } from '../domain/lifecycle.ts'

export interface NotificationsEnv {
  Variables: { caller: Caller }
}

export type NotificationsRoutesDeps = NotificationsService

const STATES: readonly NotificationState[] = ['open', 'acknowledged', 'resolved']
const LIMIT = 100

/**
 * For callers allowed `notification.read` on the app (API keys with the `admin` scope; 'forbidden'
 * otherwise), on the caller's app and mode:
 *
 * - `GET /notifications/notifications?state=open,acknowledged`: the most recently raised 100 in
 *   those states (default open and acknowledged), newest first, as `{ object: 'list', data }`.
 * - `POST /notifications/notifications/{id}/acknowledge`: acknowledges it and returns it; 'not_found'
 *   for an unknown id. One that clears by fact stays acknowledged until its service clears it.
 *
 * A notification: `{ object: 'notification', id, type, values, state, raised_at, acknowledged_at,
 * resolved_at, resolved_by }`, where `values` holds the facts it is about (such as `case_id`) and
 * `resolved_by` the fact that cleared it.
 */
export function notificationsRoutes(deps: NotificationsRoutesDeps): Hono<NotificationsEnv> {
  const routes = new Hono<NotificationsEnv>().basePath('/notifications')

  routes.get('/notifications', async (c) => {
    const appRef = reader(c.get('caller'))
    const given = c.req.query('state')
    const states = given === undefined ? (['open', 'acknowledged'] as const) : given.split(',').map((s) => s.trim())
    const wrong = states.filter((s) => !STATES.includes(s as NotificationState))
    if (states.length === 0 || wrong.length > 0) {
      throw new FlagwiseError('validation_failed', 'The state filter is not valid', { errors: [{ path: 'state', message: `Comma-separated, of ${STATES.join(', ')}` }] })
    }
    const found = await deps.list(appRef, states as NotificationState[], LIMIT)
    return c.json({ object: 'list', data: found.map(body) })
  })

  routes.post('/notifications/:id/acknowledge', async (c) => {
    const appRef = reader(c.get('caller'))
    return c.json(body(await deps.acknowledge(appRef, c.req.param('id'))))
  })

  return routes
}

function reader(ctx: Caller): AppRef {
  if (!ctx.appId || !can(ctx, { action: 'notification.read', appId: ctx.appId })) throw new FlagwiseError('forbidden', 'This API key does not have the admin scope')
  return { appId: ctx.appId, livemode: ctx.livemode }
}

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

function body(r: NotificationRecord) {
  return {
    object: 'notification',
    id: r.id,
    type: r.type,
    values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [snake(k), v])),
    state: r.state,
    raised_at: r.raisedAt?.toISOString() ?? null,
    acknowledged_at: r.acknowledgedAt?.toISOString() ?? null,
    resolved_at: r.resolvedAt?.toISOString() ?? null,
    resolved_by: r.resolvedBy,
  }
}
