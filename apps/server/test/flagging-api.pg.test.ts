// The flagging API end to end: API keys from auth, flagging on Postgres and object
// storage, and the cases module putting reports in cases through the bus.
// Runs against a real Postgres (TEST_DATABASE_URL) and S3-compatible store (TEST_S3_URL); skipped without them.
import { manualClock, type ManualClock } from '@flagwise/kernel'
import { eventContract } from '@flagwise/contracts'
import { createDatabase, createPgBus, createPgScheduler, pgTimers, memoryRateLimiter, migrate, pgUnitOfWork, withApps, type Database, type ObjectStorage, type PgBus } from '@flagwise/platform'
import { createTestBucket, createTestDatabase, testDatabaseUrl, testS3Url, type TestBucket, type TestDatabase } from '@flagwise/platform/testing'
import { moderationMigrations, pgCaseRepository, pgModerationPolicyCopy } from '@flagwise/moderation'
import { deliveryMigrations, pgDeliveryDeps } from '@flagwise/delivery'
import { flaggingMigrations, pgFlaggingRunner, subscribeFlagging, type FlaggingDeps } from '@flagwise/flagging'
import { pgTriageDeps, triageMigrations } from '@flagwise/triage'
import { authMigrations, issueApiKey, pgAppCopies, pgKeyStore, revokeApiKey, type KeyDeps } from '@flagwise/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, pgKeyResolver, type ApiDeps } from '../src/index.ts'
import { composeServices } from './support/services.ts'

const T0 = '2026-11-06T09:00:00.000Z'

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    reporter: { external_id: 'u_jane_doe' },
    reported: { external_id: 'u_john_doe' },
    category: 'asking_for_money',
    evidence: { kind: 'message', content: ['can you send me $200 first?'] },
    ...over,
  })

describe.skipIf(!testDatabaseUrl || !testS3Url)('flagging API on Postgres and object storage', () => {
  let t: TestDatabase
  let bucket: TestBucket
  let db: Database
  let bus: PgBus
  let clock: ManualClock
  let deps: ApiDeps
  let http: ReturnType<typeof createApp>['http']
  const keys = {} as Record<'live' | 'test' | 'actionsOnly' | 'revoked' | 'deletedApp' | 'otherApp', string>
  let n = 0

  const call = (path: string, init: { key?: string | undefined; method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    http.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), 'content-type': 'application/json', ...init.headers },
      ...(init.body !== undefined && { body: init.body }),
    })
  const submit = (body = report(), headers: Record<string, string> = {}, key = keys.live) => call('/v1/flagging/reports', { key, body, headers })
  const drain = () => bus.drain()

  beforeAll(async () => {
    t = await createTestDatabase()
    bucket = await createTestBucket()
    await migrate(t.ownerUrl, [authMigrations, flaggingMigrations, moderationMigrations, deliveryMigrations, triageMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { retryDelayMs: () => 0, contract: eventContract })
    clock = manualClock(T0)

    // Auth's copy of the apps, as it keeps it from the apps service's facts.
    const apps = pgAppCopies(db)
    for (const id of ['app_a', 'app_b', 'app_gone']) await apps.created(id)
    const registry = <R>(appIds: string[], fn: (d: KeyDeps) => Promise<R>) =>
      withApps(db, { appIds, livemode: true }, (tx) => fn({ store: pgKeyStore(tx), clock, newKeyId: () => `key_${++n}` }))
    await registry(['app_a', 'app_b', 'app_gone'], async (d) => {
      const issue = async (appId: string, livemode: boolean, scopes: string[]) => (await issueApiKey(d, { appId, livemode, scopes })).key
      keys.live = await issue('app_a', true, ['flagging'])
      keys.test = await issue('app_a', false, ['flagging'])
      keys.actionsOnly = await issue('app_a', true, ['actions'])
      keys.otherApp = await issue('app_b', true, ['flagging'])
      keys.deletedApp = await issue('app_gone', true, ['flagging'])
      const revoked = await issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['flagging'] })
      await revokeApiKey(d, { appId: 'app_a', keyId: revoked.record.id })
      keys.revoked = revoked.key
    })
    await apps.setDeletedAt('app_gone', clock.now())

    const flagging: FlaggingDeps = { run: pgFlaggingRunner(db, bus), storage: bucket.storage, clock, newReportId: () => `rpt_${++n}` }
    composeServices({
      bus,
      scheduler: createPgScheduler(db, { clock }),
      clock,
      newCaseId: () => `case_${++n}`,
      newDecisionId: () => `dec_${++n}`,
      newActionRequestId: () => `acr_${++n}`,
      newEventId: () => `evt_${++n}`,
      cases: { uow: pgUnitOfWork(db, bus, (tx) => ({ cases: pgCaseRepository(tx), timers: pgTimers(tx, 'moderation') })), policy: pgModerationPolicyCopy(db) },
      delivery: pgDeliveryDeps(db, bus, { clock, newActionRequestId: () => `acr_${++n}`, newEventId: () => `evt_${++n}` }),
      triage: pgTriageDeps(db, bus),
      classify: async () => ({ categoryId: 'scams_fraud.romance_scam', signals: [], injectionSuspected: false, preRuleP0: false, classifiedBy: 'llm' }),
    })
    subscribeFlagging(bus, flagging)
    // A consumer group is stored on the first drain and only gets events published after that.
    await bus.drain()
    deps = { keys: pgKeyResolver(db), limiter: memoryRateLimiter(), rateLimit: { ratePerSecond: 50, burst: 100 }, clock, flagging }
    http = createApp({ api: deps }).http
  })
  afterAll(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
    await bucket?.drop()
  })

  it('accepts a report, stores its snapshot, and shows its case once cases has picked one', async () => {
    const res = await submit()
    expect(res.status).toBe(202)
    const accepted = await res.json() as any
    expect(accepted).toEqual({ id: expect.stringMatching(/^rpt_/), object: 'report', status: 'received', case_id: null, livemode: true, received_at: T0 })
    expect(res.headers.get('idempotent-replayed')).toBeNull()
    const snapshot = JSON.parse(new TextDecoder().decode((await bucket.storage.get(`apps/app_a/${accepted.id}`))!))
    expect(snapshot).toMatchObject({ format: 'flagwise.report.v1', report_id: accepted.id, report: { reported: { externalId: 'u_john_doe' } } })

    // Before the bus runs, the report has no case yet.
    expect(await (await call(`/v1/flagging/reports/${accepted.id}`, { key: keys.live })).json() as any).toMatchObject({ status: 'received', case_id: null })
    await drain()
    const assigned = await (await call(`/v1/flagging/reports/${accepted.id}`, { key: keys.live })).json() as any
    expect(assigned).toEqual({ ...accepted, status: 'assigned', case_id: expect.stringMatching(/^case_/), joined_existing_case: false })

    // A second report about the same account joins that case.
    const second = await (await call('/v1/flagging/reports', { key: keys.live, body: report({ reporter: { external_id: 'u_jane_roe' } }) })).json() as any
    await drain()
    expect(await (await call(`/v1/flagging/reports/${second.id}`, { key: keys.live })).json() as any).toMatchObject({
      status: 'assigned',
      case_id: assigned.case_id,
      joined_existing_case: true,
    })
    expect(await bus.deadLetters()).toEqual([])
  })

  it('replays a request with the same Idempotency-Key, and refuses the key with another body', async () => {
    const first = await submit(report(), { 'idempotency-key': 'jane-8812' })
    const again = await submit(report(), { 'idempotency-key': 'jane-8812' })
    expect(again.status).toBe(202)
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    const body = await first.json() as any
    expect(await again.json() as any).toEqual(body)
    await drain()
    // Even after the report got its case, a replay answers with the first response.
    expect(await (await submit(report(), { 'idempotency-key': 'jane-8812' })).json() as any).toEqual(body)

    const other = await submit(report({ category: 'spam' }), { 'idempotency-key': 'jane-8812' })
    expect(other.status).toBe(409)
    expect(await other.json() as any).toMatchObject({ type: 'https://flagwise.dev/errors/conflict', detail: 'Idempotency-Key was already used with a different request' })
    const received = (await bus.log()).filter((l) => l.event.type === 'report.received.v1' && (l.event.data as { reportId: string }).reportId === body.id)
    expect(received).toHaveLength(1)
  })

  it('answers auth failures with 401, and a deleted app with 410', async () => {
    const missing = await call('/v1/flagging/reports', { body: report(), headers: { 'x-request-id': 'req-jane-1' } })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('content-type')).toBe('application/problem+json')
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    expect(missing.headers.get('x-request-id')).toBe('req-jane-1')
    expect(await missing.json() as any).toEqual({
      type: 'https://flagwise.dev/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Send the API key as Authorization: Bearer <key>',
      request_id: 'req-jane-1',
    })
    for (const key of ['nonsense', `fw_live_${'a'.repeat(40)}`]) {
      expect(await (await submit(report(), {}, key)).json() as any).toMatchObject({ status: 401, detail: 'The API key is not valid' })
    }
    expect(await (await submit(report(), {}, keys.revoked)).json() as any).toMatchObject({ status: 401, detail: 'The API key was revoked or has expired' })
    const gone = await submit(report(), {}, keys.deletedApp)
    expect(gone.status).toBe(410)
    expect(await gone.json() as any).toMatchObject({ type: 'https://flagwise.dev/errors/gone', detail: 'The app of this API key was deleted' })
    // An invalid incoming request id is replaced by a new one.
    const fresh = await call('/v1/flagging/reports', { headers: { 'x-request-id': 'has space' } })
    expect(fresh.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{32}$/)
  })

  it('needs the flagging scope', async () => {
    const res = await submit(report(), {}, keys.actionsOnly)
    expect(res.status).toBe(403)
    expect(await res.json() as any).toMatchObject({ type: 'https://flagwise.dev/errors/forbidden', detail: 'This API key does not have the flagging scope' })
  })

  it('answers bad requests with problem+json', async () => {
    const tooBig = await submit(report({ text: 'x'.repeat(70_000) }))
    expect(tooBig.status).toBe(413)
    expect(await tooBig.json() as any).toMatchObject({ status: 413, errors: [{ path: '', message: 'Payload exceeds 64 KB' }] })
    expect((await submit('{"reporter":')).status).toBe(400)
    expect((await submit(report(), { 'idempotency-key': 'has space' })).status).toBe(400)
    const invalid = await submit(report({ category: '', evidence: { kind: 'message', content: [{ text: 7 }] } }))
    expect(invalid.status).toBe(422)
    expect(await invalid.json() as any).toMatchObject({
      type: 'https://flagwise.dev/errors/validation_failed',
      errors: expect.arrayContaining([
        { path: 'category', message: 'Must not be empty' },
        { path: 'evidence.content[0].text', message: 'Must be a string' },
      ]),
    })
    const unknown = await call('/v1/nothing-here', { key: keys.live })
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toBe('application/problem+json')
  })

  it('shows a report only to keys of its app and mode', async () => {
    const { id } = await (await submit()).json() as any
    expect((await call(`/v1/flagging/reports/${id}`, { key: keys.otherApp })).status).toBe(404)
    expect((await call(`/v1/flagging/reports/${id}`, { key: keys.test })).status).toBe(404)
    expect(await (await call('/v1/flagging/reports/rpt_nope', { key: keys.live })).json() as any).toMatchObject({ status: 404, detail: 'No report rpt_nope' })
    const test = await (await submit(report(), {}, keys.test)).json() as any
    expect(test.livemode).toBe(false)
    expect((await call(`/v1/flagging/reports/${test.id}`, { key: keys.test })).status).toBe(200)
  })

  it('limits each app with its own token bucket', async () => {
    const limited = createApp({ api: { ...deps, limiter: memoryRateLimiter(), rateLimit: { ratePerSecond: 1, burst: 2 } } }).http
    const get = (key: string) => limited.request('/v1/flagging/reports/rpt_nope', { headers: { authorization: `Bearer ${key}` } })
    expect((await get(keys.live)).status).toBe(404)
    expect((await get(keys.live)).status).toBe(404)
    const refused = await get(keys.live)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(await refused.json() as any).toMatchObject({ type: 'https://flagwise.dev/errors/rate_limited' })
    // Another app, and the same app's test mode, have their own buckets.
    expect((await get(keys.otherApp)).status).toBe(404)
    expect((await get(keys.test)).status).toBe(404)
    clock.advance(1000)
    expect((await get(keys.live)).status).toBe(404)
  })

  it('hides internal errors behind a 500 and reports them to onError', async () => {
    const seen: string[] = []
    const broken: ObjectStorage = { ...bucket.storage, put: async () => Promise.reject(new Error('disk on fire at /var/secret')) }
    const app = createApp({ api: { ...deps, flagging: { ...deps.flagging, storage: broken }, onError: (err, id) => void seen.push(`${id}: ${(err as Error).message}`) } }).http
    const res = await app.request('/v1/flagging/reports', { method: 'POST', headers: { authorization: `Bearer ${keys.live}`, 'x-request-id': 'req-fire' }, body: report() })
    expect(res.status).toBe(500)
    expect(await res.json() as any).toEqual({ type: 'https://flagwise.dev/errors/internal_error', title: 'Internal error', status: 500, request_id: 'req-fire' })
    expect(seen).toEqual(['req-fire: disk on fire at /var/secret'])
  })
})
