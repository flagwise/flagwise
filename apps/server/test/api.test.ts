// The API edge alone, around a route that fails: what only the server sees, since everything a
// tenant meets at the edge (keys, scopes, rate limits, Idempotency-Keys, problem+json) is in the
// integration suite.
import { FlagwiseError, manualClock, type Caller } from '@flagwise/kernel'
import { memoryRateLimiter, type ServiceRoutes } from '@flagwise/platform'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApi } from '../src/index.ts'

const caller: Caller = { appId: 'app_a', appIds: ['app_a'], actor: { type: 'api_key', id: 'key_jane', scopes: ['flagging'] }, adminRole: null, appRoles: {}, livemode: true }

function apiWith(routes: ServiceRoutes, onError: (err: unknown, requestId: string) => void) {
  return createApi({
    keys: { resolve: async () => ({ ok: true, context: caller }) },
    limiter: memoryRateLimiter(),
    rateLimit: { ratePerSecond: 50, burst: 100 },
    clock: manualClock('2026-11-21T09:00:00Z'),
    routes: [routes],
    onError,
  })
}

describe('the API edge', () => {
  it('hides an internal error behind a 500 and reports it to onError, with the request id', async () => {
    const seen: string[] = []
    const routes: ServiceRoutes = new Hono<{ Variables: { caller: Caller } }>().basePath('/flagging').post('/reports', () => {
      throw new Error('disk on fire at /var/secret')
    })
    const res = await apiWith(routes, (err, id) => void seen.push(`${id}: ${(err as Error).message}`)).request('/flagging/reports', {
      method: 'POST',
      headers: { authorization: 'Bearer fw_live_jane', 'x-request-id': 'req-fire' },
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ type: 'https://flagwise.dev/errors/internal_error', title: 'Internal error', status: 500, request_id: 'req-fire' })
    expect(seen).toEqual(['req-fire: disk on fire at /var/secret'])
  })

  it("answers a route's own FlagwiseError as its problem, without calling onError", async () => {
    const seen: unknown[] = []
    const routes: ServiceRoutes = new Hono<{ Variables: { caller: Caller } }>().basePath('/flagging').get('/reports/:id', () => {
      throw new FlagwiseError('not_found', 'No report rpt_x')
    })
    const res = await apiWith(routes, (err) => void seen.push(err)).request('/flagging/reports/rpt_x', { headers: { authorization: 'Bearer fw_live_jane' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ status: 404, detail: 'No report rpt_x' })
    expect(seen).toEqual([])
  })
})
