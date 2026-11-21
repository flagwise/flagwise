// What every tenant meets at the API edge, on the report route: keys as the operator issues,
// revokes and deletes them with the CLI (401, 410), scopes (403), problem+json answers and request
// ids, Idempotency-Keys on reports, each app and mode seeing only its own reports, and a token
// bucket per app and mode (429). Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { bootstrap, createKey, deleteApp, revokeKey } from '@flagwise/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { PATHS } from '../src/paths.ts'
import { caseOf } from '../src/steps.ts'

const report = (over: Record<string, unknown> = {}) => ({
  reporter: { external_id: 'u_jane_doe' },
  reported: { external_id: 'u_john_doe' },
  category: 'asking_for_money',
  evidence: { kind: 'message', content: ['can you send me $200 first?'] },
  ...over,
})

describe.skipIf(!testDatabaseUrl)('the API edge', () => {
  let i: Install
  const submit = (key: string | null, body: unknown = report(), headers: Record<string, string> = {}) => i.call(key, PATHS.reports(), { method: 'POST', body, headers })

  beforeAll(async () => {
    i = await startInstall()
    i.net.llm = () => 'down'
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('accepts a report, keeps its evidence, and shows its case once it has one', async () => {
    const accepted = await submit(i.flaggingKey)
    expect(accepted.status).toBe(202)
    expect(accepted.body).toEqual({ id: expect.stringMatching(/^rpt_/), object: 'report', status: 'received', case_id: null, livemode: true, received_at: expect.any(String) })
    expect(accepted.headers.get('idempotent-replayed')).toBeNull()
    const caseId = await caseOf(i, accepted.body.id)
    expect((await i.call(i.flaggingKey, PATHS.report(accepted.body.id))).body).toEqual({ ...accepted.body, status: 'assigned', case_id: caseId, joined_existing_case: false })
    expect((await i.call(i.jane.key, PATHS.evidence(accepted.body.id))).status).toBe(200)

    // A second report about the same account joins that case.
    const second = await submit(i.flaggingKey, report({ reporter: { external_id: 'u_jane_roe' } }))
    expect(await caseOf(i, second.body.id)).toBe(caseId)
    expect((await i.call(i.flaggingKey, PATHS.report(second.body.id))).body).toMatchObject({ status: 'assigned', joined_existing_case: true })
  })

  it('replays a report with the same Idempotency-Key, and refuses the key with another body', async () => {
    const first = await submit(i.flaggingKey, report({ reported: { external_id: 'u_jack_doe' } }), { 'idempotency-key': 'jane-8812' })
    const again = await submit(i.flaggingKey, report({ reported: { external_id: 'u_jack_doe' } }), { 'idempotency-key': 'jane-8812' })
    expect(again.status).toBe(202)
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(again.body).toEqual(first.body)
    // Even after the report got its case, a replay answers with the first response.
    await caseOf(i, first.body.id)
    expect((await submit(i.flaggingKey, report({ reported: { external_id: 'u_jack_doe' } }), { 'idempotency-key': 'jane-8812' })).body).toEqual(first.body)

    const other = await submit(i.flaggingKey, report({ category: 'spam' }), { 'idempotency-key': 'jane-8812' })
    expect(other.status).toBe(409)
    expect(other.body).toMatchObject({ type: 'https://flagwise.dev/errors/conflict', detail: 'Idempotency-Key was already used with a different request' })
  })

  it('answers a missing, unknown or revoked key with 401, and a deleted app with 410', async () => {
    const missing = await i.call(null, PATHS.reports(), { method: 'POST', body: report(), headers: { 'x-request-id': 'req-jane-1' } })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('content-type')).toBe('application/problem+json')
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    expect(missing.headers.get('x-request-id')).toBe('req-jane-1')
    expect(missing.body).toEqual({ type: 'https://flagwise.dev/errors/unauthorized', title: 'Unauthorized', status: 401, detail: 'Send the API key as Authorization: Bearer <key>', request_id: 'req-jane-1' })
    for (const key of ['nonsense', `fw_live_${'a'.repeat(40)}`]) expect((await submit(key)).body).toMatchObject({ status: 401, detail: 'The API key is not valid' })

    // The operator revokes a key; it stops working at once.
    const spare = await createKey(i.config, { ...i.appRef, scopes: ['flagging'] })
    expect((await submit(spare.key)).status).toBe(202)
    await revokeKey(i.config, { ...i.appRef, keyId: spare.id })
    expect((await submit(spare.key)).body).toMatchObject({ status: 401, detail: 'The API key was revoked or has expired' })
    await expect(revokeKey(i.config, { ...i.appRef, keyId: 'key_none' })).rejects.toThrow('No API key key_none')

    // The operator deletes another app; its keys answer 410 once auth hears of it.
    const doomed = await bootstrap(i.config, { appName: 'John Doe Marketplace' })
    expect((await submit(doomed.liveKey)).status).toBe(202)
    await deleteApp(i.config, doomed.app.id)
    const gone = await eventually(async () => {
      const res = await submit(doomed.liveKey)
      return res.status === 410 ? res : undefined
    }, 'the deleted app answering 410')
    expect(gone.body).toMatchObject({ type: 'https://flagwise.dev/errors/gone', detail: 'The app of this API key was deleted' })

    // An invalid incoming request id is replaced by a new one.
    const fresh = await i.call(null, PATHS.reports(), { headers: { 'x-request-id': 'has space' } })
    expect(fresh.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{32}$/)
  })

  it('needs the flagging scope to file a report', async () => {
    const actionsOnly = await createKey(i.config, { ...i.appRef, scopes: ['actions'] })
    const res = await submit(actionsOnly.key)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ type: 'https://flagwise.dev/errors/forbidden', detail: 'This API key does not have the flagging scope' })
  })

  it('answers bad requests with problem+json', async () => {
    const tooBig = await submit(i.flaggingKey, report({ text: 'x'.repeat(70_000) }))
    expect(tooBig.status).toBe(413)
    expect(tooBig.body).toMatchObject({ status: 413, errors: [{ path: '', message: 'Payload exceeds 64 KB' }] })
    expect((await i.call(i.flaggingKey, PATHS.reports(), { method: 'POST', raw: '{"reporter":' })).status).toBe(400)
    expect((await submit(i.flaggingKey, report(), { 'idempotency-key': 'has space' })).status).toBe(400)
    const invalid = await submit(i.flaggingKey, report({ category: '', evidence: { kind: 'message', content: [{ text: 7 }] } }))
    expect(invalid.status).toBe(422)
    expect(invalid.body).toMatchObject({
      type: 'https://flagwise.dev/errors/validation_failed',
      errors: expect.arrayContaining([
        { path: 'category', message: 'Must not be empty' },
        { path: 'evidence.content[0].text', message: 'Must be a string' },
      ]),
    })
    const unknown = await i.call(i.flaggingKey, '/nothing-here')
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toBe('application/problem+json')
  })

  it('shows a report only to keys of its app and mode', async () => {
    const other = await bootstrap(i.config, { appName: 'Jane Doe Community' })
    const { body } = await submit(i.flaggingKey)
    expect((await i.call(other.liveKey, PATHS.report(body.id))).status).toBe(404)
    expect((await i.call(i.testKey, PATHS.report(body.id))).status).toBe(404)
    expect((await i.call(i.flaggingKey, PATHS.report('rpt_nope'))).body).toMatchObject({ status: 404, detail: 'No report rpt_nope' })
    const test = await submit(i.testKey)
    expect(test.body.livemode).toBe(false)
    expect((await i.call(i.testKey, PATHS.report(test.body.id))).status).toBe(200)
  })
})

describe.skipIf(!testDatabaseUrl)('the rate limit', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall({ rateLimit: { perSecond: 1, burst: 2 } })
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('limits each app and mode with its own token bucket', async () => {
    const other = await bootstrap(i.config, { appName: 'Jane Doe Community' })
    const get = (key: string) => i.call(key, PATHS.report('rpt_nope'))
    expect((await get(i.flaggingKey)).status).toBe(404)
    expect((await get(i.flaggingKey)).status).toBe(404)
    const refused = await get(i.flaggingKey)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(refused.body).toMatchObject({ type: 'https://flagwise.dev/errors/rate_limited' })
    // Another app, and the same app's test mode, have their own buckets.
    expect((await get(other.liveKey)).status).toBe(404)
    expect((await get(i.testKey)).status).toBe(404)
    i.clock.advance(1000)
    expect((await get(i.flaggingKey)).status).toBe(404)
  })
})
