// Webhooks and action requests with the server's own wiring on a real Postgres: an endpoint added
// through the CLI's setup functions, a report through the API becoming a signed report.triaged post
// from the running worker, the action request routes, and rotating the signing secret and the
// master key. Skipped without TEST_DATABASE_URL.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgActionRequestStore, verify } from '@flagwise/delivery'
import { newKeyringEntry, scopeOfRef, withTenant } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addWebhookEndpoint,
  bootstrap,
  createKey,
  createServer,
  listWebhookEndpoints,
  migrateFromEnv,
  removeWebhookEndpoint,
  rewrapSecrets,
  rollWebhookSecret,
  serverConfigFromEnv,
  type Bootstrapped,
  type Server,
  type ServerConfig,
} from '../src/index.ts'

interface Received {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

const K1 = newKeyringEntry('k1', () => new Uint8Array(32).fill(1))
const K2 = newKeyringEntry('k2', () => new Uint8Array(32).fill(2))

/** Resolves once `check` passes, polling every 50 ms for up to 10 s. */
async function eventually<T>(check: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = check()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting')
}

/** Resolves once `check` resolves to a value, polling every 50 ms for up to 10 s. */
async function eventuallyAsync<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting')
}

describe.skipIf(!testDatabaseUrl)('webhooks on the server', () => {
  let t: TestDatabase
  let env: Record<string, string>
  let config: ServerConfig
  let server: Server
  let installed: Bootstrapped
  let received: Received[]
  let secret: string
  let endpointId: string
  const json = async (res: Response) => (await res.json()) as Record<string, any>
  const tenant = () => ({ appId: installed.app.id, livemode: true })
  const call = (key: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    server.app.http.request(`/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  /** The body of a GET, or undefined when it did not succeed (such as rate limited while polling). */
  const got = async (key: string, path: string) => {
    const res = await call(key, path)
    return res.ok ? await json(res) : undefined
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    env = { DATABASE_APP_URL: t.appUrl, DATABASE_SYSTEM_URL: t.systemUrl, STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')), SECRETS_ENCRYPTION_KEY: K1 }
    await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` })
    config = await serverConfigFromEnv(env)
    installed = await bootstrap(config, { appName: 'Jane Doe Dating iOS' })
    const added = await addWebhookEndpoint(config, tenant(), { url: 'https://hooks.janedoe.example/flagwise' })
    secret = added.secret!
    endpointId = added.endpoint.id
    received = []
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      received.push({ url: String(url), headers: init!.headers as Record<string, string>, body: init!.body as string })
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    server = createServer(config, { fetch: fakeFetch, onError: () => {} })
    await server.start()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('posts a signed report.triaged for a report, from the running worker', async () => {
    const post = await call(installed.liveKey, '/flagging/reports', {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: 'u_john_doe' }, category: 'asking_for_money', text: 'He asked me to send $200 first', evidence: { kind: 'message', content: ['can you send me $200 first?'] } },
    })
    expect(post.status).toBe(202)
    const hook = await eventually(() => received.find((r) => r.body.includes('"report.triaged"')))
    expect(hook.url).toBe('https://hooks.janedoe.example/flagwise')
    expect(hook.headers['content-type']).toBe('application/json')
    expect(verify(secret, hook.headers, hook.body).ok).toBe(true)
    const body = JSON.parse(hook.body)
    expect(body).toMatchObject({ type: 'report.triaged', app_id: installed.app.id, livemode: true, data: { category_id: 'other', classified_by: 'rules' } })
    expect(body.id).toMatch(/^evt_/)
    expect(hook.headers['webhook-id']).toBe(body.id)
  })

  it('lets the tenant read, confirm and fail action requests with an actions key only', async () => {
    const ref = tenant()
    await withTenant(server.db, scopeOfRef(ref), async (tx) => {
      const store = pgActionRequestStore(tx)
      for (const id of ['acr_a', 'acr_b']) await store.insert({ id, tenant: ref, caseId: 'case_x', decisionId: 'dec_x', actionKey: 'suspend_7d', status: 'pending', failReason: null, retryId: null, replacedBy: null })
    })
    const admin = await createKey(config, { ...ref, scopes: ['admin'] })
    expect((await call(admin.key, '/delivery/action-requests/acr_a')).status).toBe(403)

    const read = await call(installed.liveKey, '/delivery/action-requests/acr_a')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ object: 'action_request', id: 'acr_a', status: 'pending', action_key: 'suspend_7d', case_id: 'case_x', decision_id: 'dec_x', fail_reason: null })

    expect((await call(installed.liveKey, '/delivery/action-requests/acr_a/confirm', { method: 'POST' })).status).toBe(200)
    // The same answer again is harmless; the other answer is a conflict.
    expect((await call(installed.liveKey, '/delivery/action-requests/acr_a/confirm', { method: 'POST' })).status).toBe(200)
    expect((await call(installed.liveKey, '/delivery/action-requests/acr_a/fail', { method: 'POST', body: { reason: 'User not found' } })).status).toBe(409)

    expect((await call(installed.liveKey, '/delivery/action-requests/acr_b/fail', { method: 'POST', body: {} })).status).toBe(422)
    const failed = await call(installed.liveKey, '/delivery/action-requests/acr_b/fail', { method: 'POST', body: { reason: 'User not found' } })
    expect(await failed.json()).toMatchObject({ status: 'failed', fail_reason: 'User not found' })
    expect((await call(installed.liveKey, '/delivery/action-requests/acr_none')).status).toBe(404)
    expect((await call(installed.liveKey, '/delivery/action-requests/acr_none/confirm', { method: 'POST' })).status).toBe(404)
  })

  it('takes registered action keys through a decision to a signed action.requested, then to actioned once confirmed', async () => {
    const admin = await createKey(config, { ...tenant(), scopes: ['admin'] })
    const actions = {
      data: [
        { key: 'warn', label: { en: 'Warn' }, categories: ['*'] },
        { key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, reverse_key: 'unsuspend', categories: ['scams_fraud'] },
        { key: 'unsuspend', label: { en: 'Lift suspension' }, categories: ['*'] },
      ],
    }
    expect((await call(installed.liveKey, '/policy/action-keys')).status).toBe(403)
    expect((await call(installed.liveKey, '/policy/action-keys', { method: 'PUT', body: actions })).status).toBe(403)
    const bad = await call(admin.key, '/policy/action-keys', { method: 'PUT', body: { data: [{ ...actions.data[1] }] } })
    expect(bad.status).toBe(422)
    expect(await json(bad)).toMatchObject({ errors: [{ path: 'data[0].reverse_key' }] })

    const put = await call(admin.key, '/policy/action-keys', { method: 'PUT', body: actions })
    expect(put.status).toBe(200)
    const listed = await json(await call(admin.key, '/policy/action-keys'))
    expect(listed).toEqual(await json(put))
    expect(listed.data[1]).toEqual({ object: 'action_key', key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: null, reverse_key: 'unsuspend', auto_allowed: false, categories: ['scams_fraud'] })
    // Test mode has its own list.
    const testAdmin = await createKey(config, { ...tenant(), livemode: false, scopes: ['admin'] })
    expect((await json(await call(testAdmin.key, '/policy/action-keys'))).data).toEqual([])

    const report = await call(installed.liveKey, '/flagging/reports', {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: 'u_jack_doe' }, category: 'asking_for_money', evidence: { kind: 'message', content: ['send me $200'] } },
    })
    const { id: reportId } = await json(report)
    const triaged = await eventually(() => received.find((r) => r.body.includes('"report.triaged"') && r.body.includes(reportId)))
    const caseId = JSON.parse(triaged.body).data.case_id as string
    expect((await call(admin.key, `/moderation/cases/${caseId}/claim`, { method: 'POST' })).status).toBe(200)
    const decision = { outcome: 'violation', category_id: 'spam.spam', severity: 'P2', action_keys: ['suspend_7d'] }
    // suspend_7d does not allow spam.
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision })).status).toBe(422)
    const decided = await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: { ...decision, category_id: 'scams_fraud.romance_scam', severity: 'P1' } })
    expect(decided.status).toBe(201)

    const hook = await eventually(() => received.find((r) => r.body.includes('"action.requested"')))
    expect(verify(secret, hook.headers, hook.body).ok).toBe(true)
    const requested = JSON.parse(hook.body).data
    expect(requested).toMatchObject({ action_key: 'suspend_7d', case_id: caseId, subject_external_id: 'u_jack_doe', reason: 'decision' })
    expect(await json(await call(installed.liveKey, `/delivery/action-requests/${requested.action_request_id}`))).toMatchObject({ status: 'pending' })
    expect((await call(installed.liveKey, `/delivery/action-requests/${requested.action_request_id}/confirm`, { method: 'POST' })).status).toBe(200)
    const actioned = await eventuallyAsync(async () => {
      const c = await got(admin.key, `/moderation/cases/${caseId}`)
      return c?.state === 'actioned' ? c : undefined
    })
    expect(actioned).toMatchObject({ state: 'actioned', decision: { action_keys: ['suspend_7d'] } })

    // A removed key can no longer be picked.
    await call(admin.key, '/policy/action-keys', { method: 'PUT', body: { data: [actions.data[0]] } })
    expect((await json(await call(admin.key, '/policy/action-keys'))).data.map((k: { key: string }) => k.key)).toEqual(['warn'])

    // The audit log has the case's whole story, each step with its actor, and the chain verifies.
    expect((await call(installed.liveKey, '/audit/entries')).status).toBe(403)
    const timeline = await eventuallyAsync(async () => {
      const page = await got(admin.key, `/audit/entries?case_id=${caseId}`)
      return page?.data.some((e: { action: string }) => e.action === 'decision.actions_confirmed') ? page.data : undefined
    })
    const byAction = new Map<string, any>(timeline.map((e: { action: string }) => [e.action, e]))
    expect([...byAction.keys()].sort()).toEqual(
      ['action.confirmed', 'action.requested', 'case.claimed', 'case.classified', 'case.decided', 'case.opened', 'case.triaged', 'decision.actions_confirmed'].sort(),
    )
    expect(byAction.get('case.decided')).toMatchObject({
      object: 'audit_entry',
      actor: { type: 'api_key', id: admin.id },
      target: { type: 'case', id: caseId },
      facts: { action_keys: ['suspend_7d'], decided_by: admin.id, request_id: expect.stringMatching(/^req_/) },
      pii: null,
    })
    expect(byAction.get('case.triaged')).toMatchObject({ actor: { type: 'system', id: 'system' } })
    expect(byAction.get('action.confirmed')).toMatchObject({ actor: { type: 'api_key' }, target: { type: 'action_request', id: requested.action_request_id } })
    expect(byAction.get('action.confirmed').actor.id).not.toBe(admin.id)

    const configChanges = await eventuallyAsync(async () => {
      const page = await got(admin.key, `/audit/entries?actor_id=${admin.id}`)
      const changes = page?.data.filter((e: { action: string }) => e.action === 'config.action_keys_replaced')
      return changes?.length === 2 ? changes : undefined
    })
    expect(configChanges[0].facts.before).toEqual([])
    expect(configChanges[1].facts.after.map((k: { key: string }) => k.key)).toEqual(['warn'])
    // The CLI issued the admin key, as the operator.
    const keyEvents = (await json(await call(admin.key, '/audit/entries?actor_id=cli'))).data
    expect(keyEvents).toContainEqual(expect.objectContaining({ action: 'api_key.issued', actor: { type: 'operator', id: 'cli' }, target: { type: 'api_key', id: admin.id }, facts: { scopes: ['admin'] } }))
    expect(JSON.stringify(keyEvents)).not.toContain(admin.key.slice(8))

    expect(await json(await call(admin.key, '/audit/verify'))).toMatchObject({ object: 'audit_verification', ok: true })
    expect((await call(admin.key, '/audit/entries?limit=0')).status).toBe(422)
    // Test mode keeps its own log.
    expect((await json(await call(testAdmin.key, '/audit/entries?actor_id=' + admin.id))).data).toEqual([])
  })

  it('lists and removes endpoints, rolls the signing secret, and rewraps under a new master key', async () => {
    expect((await listWebhookEndpoints(config, tenant())).map((e) => e.id)).toEqual([endpointId])
    const rolled = await rollWebhookSecret(config, tenant(), 0)
    expect(rolled.version).toBe(2)

    const rotated = await serverConfigFromEnv({ ...env, SECRETS_ENCRYPTION_KEY: `${K2},${K1}` })
    expect(await rewrapSecrets(rotated)).toBe(2)
    expect(await rewrapSecrets(rotated)).toBe(0)
    await expect(addWebhookEndpoint({ ...config, secrets: null }, tenant(), { url: 'https://hooks.janedoe.example/b' })).rejects.toThrow('Set SECRETS_ENCRYPTION_KEY')

    await removeWebhookEndpoint(config, tenant(), endpointId)
    expect(await listWebhookEndpoints(config, tenant())).toEqual([])
    await expect(removeWebhookEndpoint(config, tenant(), endpointId)).rejects.toThrow(/No webhook endpoint/)
  })
})
