// The erasure routes. The edge authenticates and sets the caller; these routes authorize
// from it and call the use cases.

import { can, FlagwiseError, type Clock, type Caller, type AppRef } from '@flagwise/kernel'
import { Hono } from 'hono'
import { erasureStatus, type ErasureRecord } from '../app/erasure.ts'
import type { PrivacyService } from '../app/handlers.ts'

export interface PrivacyEnv {
  Variables: { caller: Caller }
}

export interface PrivacyRoutesDeps extends PrivacyService {
  readonly clock: Clock
}

const MAX_ID = 128

/**
 * For callers allowed `subject.erase` on the app (API keys with the `admin` scope; 'forbidden'
 * otherwise), on the caller's app and mode:
 *
 * - `POST /privacy/subjects/{external_id}/erase`: starts erasing the account's data in every service that
 *   holds it, within 24 hours: 202 with the new erasure, or 200 with the one already in progress.
 * - `GET /privacy/erasures/{id}`: its progress; 'not_found' for an unknown id.
 *
 * An erasure: `{ object: 'erasure', id, subject_external_id, status (in_progress, overdue or
 * completed), requested_at, deadline_at, completed_at, held_items, groups }`, where `groups` lists
 * every consumer group the request reached (empty until the bus says), each `{ group, status
 * (pending, failed, erased, nothing_held or retained), answered_at, held_items, reason, error }`.
 */
export function privacyRoutes(deps: PrivacyRoutesDeps): Hono<PrivacyEnv> {
  const routes = new Hono<PrivacyEnv>().basePath('/privacy')

  routes.post('/subjects/:external_id/erase', async (c) => {
    const appRef = eraser(c.get('caller'))
    const subject = c.req.param('external_id')
    if (subject.length === 0 || subject.length > MAX_ID) {
      throw new FlagwiseError('validation_failed', 'The account id is not valid', { errors: [{ path: 'external_id', message: `An id of 1 to ${MAX_ID} characters` }] })
    }
    const { erasure, created } = await deps.erase(appRef, subject)
    return c.json(body(erasure, deps.clock.now()), created ? 202 : 200)
  })

  routes.get('/erasures/:id', async (c) => {
    const appRef = eraser(c.get('caller'))
    const erasure = await deps.find(appRef, c.req.param('id'))
    if (!erasure) throw new FlagwiseError('not_found', 'No such erasure')
    return c.json(body(erasure, deps.clock.now()))
  })

  return routes
}

function eraser(ctx: Caller): AppRef {
  if (!ctx.appId || !can(ctx, { action: 'subject.erase', appId: ctx.appId })) throw new FlagwiseError('forbidden', 'This API key does not have the admin scope')
  return { appId: ctx.appId, livemode: ctx.livemode }
}

function body(e: ErasureRecord, now: Date) {
  return {
    object: 'erasure',
    id: e.id,
    subject_external_id: e.subjectExternalId,
    status: erasureStatus(e, now),
    requested_at: e.requestedAt.toISOString(),
    deadline_at: e.deadlineAt.toISOString(),
    completed_at: e.completedAt?.toISOString() ?? null,
    held_items: e.heldItems,
    groups: Object.entries(e.groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, a]) => ({ group, status: a.status, answered_at: a.at?.toISOString() ?? null, held_items: a.heldItems, reason: a.reason, error: a.error })),
  }
}
