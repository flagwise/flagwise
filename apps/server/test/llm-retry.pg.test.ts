// Retrying the LLM for cases it failed on, with the server's own wiring on a real Postgres and
// short retry delays: the install's LLM is down until a test brings it back. Skipped without
// TEST_DATABASE_URL.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifierPrompt, LlmError, type LlmProvider } from '@flagwise/classify'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootstrap, createKey, createServer, migrateFromEnv, serverConfigFromEnv, type Bootstrapped, type Server, type ServerConfig } from '../src/index.ts'

/** Resolves once `check` resolves to a value, polling every 50 ms for up to 15 s. */
async function eventually<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting')
}

const DELAYS = [400, 400, 400]

describe.skipIf(!testDatabaseUrl)('LLM retries on the server', () => {
  let t: TestDatabase
  let config: ServerConfig
  let server: Server
  let installed: Bootstrapped
  let admin: { key: string; id: string }
  let down = true
  let calls = 0
  const provider: LlmProvider = {
    async complete(request) {
      calls++
      if (down) throw new LlmError({ kind: 'server' }, 'The provider is down')
      const json = {
        category_id: 'scams_fraud.investment_scam',
        custom_category_id: null,
        confidence: 0.9,
        signals: [],
        summary: 'The reported account pushed a crypto scheme.',
        injection_suspected: false,
      }
      return { json, usage: { input: 100, output: 20, cached: 0 }, model: request.model }
    },
  }
  const json = async (res: Response) => (await res.json()) as Record<string, any>
  const tenant = () => ({ orgId: installed.org.id, appId: installed.app.id, livemode: true })
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
  const caseFor = async (reported: string) => {
    const res = await call(installed.liveKey, '/flagging/reports', {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: reported }, category: 'asking_for_money', evidence: { kind: 'message', content: ['buy my coin'] } },
    })
    const reportId = (await json(res)).id as string
    const caseId = await eventually(async () => ((await got(installed.liveKey, `/flagging/reports/${reportId}`))?.case_id as string | null) ?? undefined)
    return caseIn(caseId, (c) => c.state !== 'classifying')
  }
  const caseIn = (caseId: string, check: (c: Record<string, any>) => boolean) =>
    eventually(async () => {
      const c = await got(admin.key, `/moderation/cases/${caseId}`)
      return c && check(c) ? c : undefined
    })
  const setLlm = (fallback: boolean) => call(admin.key, '/policy/llm-settings', { method: 'PUT', body: { rules_only: false, fallback_to_rules: fallback } })

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` })
    const base = await serverConfigFromEnv({ DATABASE_APP_URL: t.appUrl, DATABASE_SYSTEM_URL: t.systemUrl, STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')) })
    config = { ...base, llm: { ...base.llm, llm: { provider, model: 'small', escalationModel: 'strong', prompt: classifierPrompt('You classify user reports.') } } }
    installed = await bootstrap(config, { orgName: 'Jane Doe Dating', appName: 'Jane Doe Dating iOS' })
    admin = await createKey(config, { ...tenant(), scopes: ['admin'] })
    server = createServer(config, { onError: () => {}, llmRetryDelaysMs: DELAYS })
    await server.start()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })
  beforeEach(() => {
    down = true
  })

  it('reclassifies a case triaged by rules once the LLM answers, and tells the tenant again', async () => {
    await setLlm(true)
    const c = await caseFor('u_jack_doe')
    expect(c).toMatchObject({ state: 'open', classified_by: 'rules', category_id: 'other', severity: 'P2' })
    const before = calls
    await eventually(async () => (calls >= before + 1 ? true : undefined))
    down = false

    const after = await caseIn(c.id, (x) => x.classified_by === 'llm')
    expect(after).toMatchObject({ state: 'open', category_id: 'scams_fraud.investment_scam', severity: 'P1' })
    expect(await json(await call(admin.key, `/classify/classifications/${c.id}`))).toMatchObject({ classified_by: 'llm', summary: 'The reported account pushed a crypto scheme.' })
    const timeline = await eventually(async () => {
      const page = await got(admin.key, `/audit/entries?case_id=${c.id}`)
      const triaged = page?.data.filter((e: { action: string }) => e.action === 'case.triaged')
      return triaged?.length === 2 ? page!.data : undefined
    })
    expect(timeline.find((e: { action: string }) => e.action === 'case.reclassified')).toMatchObject({ facts: { category_id: 'scams_fraud.investment_scam', classified_by: 'llm' } })
  })

  it('moves an untriaged case to open once the LLM answers', async () => {
    await setLlm(false)
    const c = await caseFor('u_jim_doe')
    expect(c).toMatchObject({ state: 'untriaged', severity: null })
    down = false
    expect(await caseIn(c.id, (x) => x.state === 'open')).toMatchObject({ classified_by: 'llm', category_id: 'scams_fraud.investment_scam', severity: 'P1' })
  })

  it("leaves a case a moderator has taken alone, keeping the LLM's answer in classify", async () => {
    await setLlm(true)
    const c = await caseFor('u_joe_doe')
    expect((await call(admin.key, `/moderation/cases/${c.id}/claim`, { method: 'POST' })).status).toBe(200)
    down = false
    await eventually(async () => ((await got(admin.key, `/classify/classifications/${c.id}`))?.classified_by === 'llm' ? true : undefined))
    await server.bus.drain()
    expect(await json(await call(admin.key, `/moderation/cases/${c.id}`))).toMatchObject({ state: 'claimed', classified_by: 'rules', category_id: 'other' })
  })

  it('gives up quietly when the retries run out', async () => {
    await setLlm(false)
    const c = await caseFor('u_jeff_doe')
    const before = calls
    // The first classify call, then one per delay.
    await eventually(async () => (calls - before >= DELAYS.length ? true : undefined))
    await new Promise((r) => setTimeout(r, 1_000))
    expect(calls - before).toBe(DELAYS.length)
    expect(await json(await call(admin.key, `/moderation/cases/${c.id}`))).toMatchObject({ state: 'untriaged' })
    expect((await server.bus.deadLetters()).filter((d) => d.group === 'classify.retry')).toEqual([])
  })
})
