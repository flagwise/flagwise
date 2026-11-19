// Working a case to the end with the server's own wiring on a real Postgres: correcting it before
// deciding, the reports a decision was made on, Idempotency-Keys, and answering a failed action
// with another one. Skipped without TEST_DATABASE_URL.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgActionRequestStore } from '@flagwise/delivery'
import { scopeOfRef, withTenant } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrap, createKey, createServer, migrateFromEnv, serverConfigFromEnv, type Bootstrapped, type Server, type ServerConfig } from '../src/index.ts'

/** Resolves once `check` resolves to a value, polling every 50 ms for up to 10 s. */
async function eventually<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting')
}

describe.skipIf(!testDatabaseUrl)('the case loop on the server', () => {
  let t: TestDatabase
  let config: ServerConfig
  let server: Server
  let installed: Bootstrapped
  const json = async (res: Response) => (await res.json()) as Record<string, any>
  const tenant = () => ({ appId: installed.app.id, livemode: true })
  const call = (key: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    server.app.http.request(`/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  /** The body of a GET, or undefined when it did not succeed (such as rate limited while polling). */
  const got = async (key: string, path: string) => {
    const res = await call(key, path)
    return res.ok ? await json(res) : undefined
  }
  const report = async (reported: string) => {
    const res = await call(installed.liveKey, '/flagging/reports', {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: reported }, category: 'asking_for_money', evidence: { kind: 'message', content: ['send me $200'] } },
    })
    return (await json(res)).id as string
  }
  const caseOf = (reportId: string) =>
    eventually(async () => {
      const r = await got(installed.liveKey, `/flagging/reports/${reportId}`)
      return (r?.case_id as string | null) ?? undefined
    })
  const caseIn = (key: string, caseId: string, check: (c: Record<string, any>) => boolean) =>
    eventually(async () => {
      const c = await got(key, `/moderation/cases/${caseId}`)
      return c && check(c) ? c : undefined
    })
  const requestsOf = (decisionId: string) => withTenant(server.db, scopeOfRef(tenant()), (tx) => pgActionRequestStore(tx).findByDecision(tenant(), decisionId))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` })
    config = await serverConfigFromEnv({ DATABASE_APP_URL: t.appUrl, DATABASE_SYSTEM_URL: t.systemUrl, STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')) })
    installed = await bootstrap(config, { appName: 'Jane Doe Dating iOS' })
    server = createServer(config, { onError: () => {} })
    await server.start()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('corrects a case, decides it on the reports shown, and answers a failed action with another', async () => {
    const admin = await createKey(config, { ...tenant(), scopes: ['admin'] })
    const other = await createKey(config, { ...tenant(), scopes: ['admin'] })
    const actions = [
      { key: 'warn', label: { en: 'Warn' }, categories: ['*'] },
      { key: 'suspend_7d', label: { en: 'Suspend 7 days' }, categories: ['scams_fraud'] },
      { key: 'ban', label: { en: 'Ban' }, categories: ['*'] },
    ]
    expect((await call(admin.key, '/policy/action-keys', { method: 'PUT', body: { data: actions } })).status).toBe(200)

    const first = await report('u_jack_doe')
    const caseId = await caseOf(first)
    await caseIn(admin.key, caseId, (c) => c.state === 'open')

    // Correcting needs the caller's own claim.
    expect((await call(admin.key, `/moderation/cases/${caseId}`, { method: 'PATCH', body: { severity: 'P0' } })).status).toBe(409)
    expect((await call(admin.key, `/moderation/cases/${caseId}/claim`, { method: 'POST' })).status).toBe(200)
    expect((await call(other.key, `/moderation/cases/${caseId}`, { method: 'PATCH', body: { severity: 'P0' } })).status).toBe(409)
    expect((await call(admin.key, `/moderation/cases/${caseId}`, { method: 'PATCH', body: {} })).status).toBe(422)

    const corrected = await json(await call(admin.key, `/moderation/cases/${caseId}`, { method: 'PATCH', body: { category_id: 'scams_fraud.romance_scam', severity: 'P0' } }))
    expect(corrected).toMatchObject({ state: 'claimed', category_id: 'scams_fraud.romance_scam', triage: { severity: 'P0' }, claim: { holder: admin.id } })
    // P0 is never lowered, and an unknown category is refused.
    expect((await call(admin.key, `/moderation/cases/${caseId}`, { method: 'PATCH', body: { severity: 'P2' } })).status).toBe(422)
    expect((await call(admin.key, `/moderation/cases/${caseId}`, { method: 'PATCH', body: { category_id: 'made_up' } })).status).toBe(422)

    // A report joining while the case is claimed is not part of a decision made on the first one.
    const second = await report('u_jack_doe')
    await caseIn(admin.key, caseId, (c) => c.report_count === 2)
    expect(await caseOf(second)).toBe(caseId)

    const decision = { outcome: 'violation', category_id: 'scams_fraud.romance_scam', severity: 'P0', action_keys: ['suspend_7d'], report_ids: [first] }
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: { ...decision, report_ids: ['rpt_unknown'] } })).status).toBe(422)
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision, headers: { 'idempotency-key': 'bad key' } })).status).toBe(400)
    const decided = await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision, headers: { 'idempotency-key': 'decide-1' } })
    expect(decided.status).toBe(201)
    const made = await json(decided)
    expect(made).toMatchObject({ report_ids: [first], action_keys: ['suspend_7d'] })

    // A retry with the same key gets the first answer; the key with another request is refused.
    const replay = await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision, headers: { 'idempotency-key': 'decide-1' } })
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(await json(replay)).toEqual(made)
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: { ...decision, report_ids: [first, second] }, headers: { 'idempotency-key': 'decide-1' } })).status).toBe(409)
    // Without the key, the second decision is refused as usual.
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision })).status).toBe(409)

    const [suspend] = await eventually(async () => {
      const found = await requestsOf(made.id)
      return found.length ? found : undefined
    })
    expect((await call(admin.key, `/moderation/cases/${caseId}/actions/retry`, { method: 'POST', body: { action_keys: ['ban'] } })).status).toBe(409)
    expect((await call(installed.liveKey, `/delivery/action-requests/${suspend!.id}/fail`, { method: 'POST', body: { reason: 'Account already deleted' } })).status).toBe(200)
    await caseIn(admin.key, caseId, (c) => c.state === 'action_failed')

    // Only keys the category allows, each once.
    expect((await call(admin.key, `/moderation/cases/${caseId}/actions/retry`, { method: 'POST', body: { action_keys: ['ban', 'ban'] } })).status).toBe(422)
    expect((await call(admin.key, `/moderation/cases/${caseId}/actions/retry`, { method: 'POST', body: {} })).status).toBe(422)
    const retried = await call(admin.key, `/moderation/cases/${caseId}/actions/retry`, { method: 'POST', body: { action_keys: ['ban'] } })
    expect(retried.status).toBe(200)
    expect(await json(retried)).toMatchObject({ state: 'decided' })
    // Delivery carries out the retry from case.actions_retried, a moment after the answer.
    const all = await eventually(async () => {
      const found = await requestsOf(made.id)
      return found.length === 2 ? found : undefined
    })
    expect(all.map((r) => [r.actionKey, r.status, r.replacedBy !== null])).toEqual([
      ['suspend_7d', 'failed', true],
      ['ban', 'pending', false],
    ])
    expect(await json(await call(installed.liveKey, `/delivery/action-requests/${suspend!.id}`))).toMatchObject({ status: 'failed' })

    expect((await call(installed.liveKey, `/delivery/action-requests/${all[1]!.id}/confirm`, { method: 'POST' })).status).toBe(200)
    await caseIn(admin.key, caseId, (c) => c.state === 'actioned')

    const timeline = await eventually(async () => {
      const page = await got(admin.key, `/audit/entries?case_id=${caseId}`)
      if (!page) return undefined
      const types = page.data.map((e: { action: string }) => e.action) as string[]
      return types.includes('decision.actions_confirmed') ? page.data : undefined
    })
    const entry = (action: string) => timeline.find((e: { action: string }) => e.action === action)
    expect(entry('case.corrected')).toMatchObject({
      actor: { type: 'api_key', id: admin.id },
      facts: { before: { severity: expect.any(String) }, after: { categoryId: 'scams_fraud.romance_scam', severity: 'P0' }, corrected_by: admin.id },
    })
    expect(entry('case.decided')).toMatchObject({ facts: { report_ids: [first] } })
    expect(entry('case.actions_retried')).toMatchObject({ facts: { action_keys: ['ban'], retried_by: admin.id } })
    expect(timeline.filter((e: { action: string }) => e.action === 'action.requested').at(-1)).toMatchObject({ facts: { action_key: 'ban', replaces: [suspend!.id] } })
  })

  it('answers a failure with nothing, and the case is actioned once the rest is confirmed', async () => {
    const admin = await createKey(config, { ...tenant(), scopes: ['admin'] })
    const caseId = await caseOf(await report('u_john_doe'))
    await caseIn(admin.key, caseId, (c) => c.state === 'open')
    await call(admin.key, `/moderation/cases/${caseId}/claim`, { method: 'POST' })
    const made = await json(
      await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: { outcome: 'violation', category_id: 'scams_fraud.romance_scam', severity: 'P1', action_keys: ['warn', 'ban'] } }),
    )
    const [warn, ban] = await eventually(async () => {
      const found = await requestsOf(made.id)
      return found.length === 2 ? found : undefined
    })
    await call(installed.liveKey, `/delivery/action-requests/${ban!.id}/fail`, { method: 'POST', body: { reason: 'Not supported' } })
    await caseIn(admin.key, caseId, (c) => c.state === 'action_failed')
    expect(await json(await call(admin.key, `/moderation/cases/${caseId}/actions/retry`, { method: 'POST', body: { action_keys: [] } }))).toMatchObject({ state: 'decided' })
    await call(installed.liveKey, `/delivery/action-requests/${warn!.id}/confirm`, { method: 'POST' })
    await caseIn(admin.key, caseId, (c) => c.state === 'actioned')
  })
})
