// The whole loop with nothing outside the machine: the fake LLM, evidence on local disk, a master
// key from the environment and a webhook receiver on loopback over http:, with the real fetch.
// Only Postgres is needed (TEST_DATABASE_URL); skipped without it.
import { mkdtempSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from '@flagwise/delivery'
import { newKeyringEntry } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addWebhookEndpoint, bootstrap, createKey, createServer, migrateFromEnv, serverConfigFromEnv, type Bootstrapped, type Server } from '../src/index.ts'

async function eventually<T>(check: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting')
}

describe.skipIf(!testDatabaseUrl)('local development with no outside service', () => {
  let t: TestDatabase
  let server: Server
  let receiver: HttpServer
  let installed: Bootstrapped
  let admin: { key: string }
  let secret: string
  const hooks: { headers: Record<string, string>; body: string }[] = []
  const call = (key: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    server.app.http.request(`/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  const got = async (key: string, path: string) => {
    const res = await call(key, path)
    return res.ok ? ((await res.json()) as Record<string, any>) : undefined
  }

  beforeAll(async () => {
    receiver = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hooks.push({ headers: req.headers as Record<string, string>, body })
        res.end('ok')
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/flagwise`

    t = await createTestDatabase()
    await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` })
    const config = await serverConfigFromEnv({
      DATABASE_APP_URL: t.appUrl,
      DATABASE_SYSTEM_URL: t.systemUrl,
      STORAGE_DRIVER: 'local',
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')),
      LLM_PROVIDER: 'fake',
      SECRETS_ENCRYPTION_KEY: newKeyringEntry('dev'),
      WEBHOOKS_ALLOW_HTTP: 'true',
    })
    installed = await bootstrap(config, { appName: 'Jane Doe Dating iOS' })
    const tenant = { appId: installed.app.id, livemode: true }
    admin = await createKey(config, { ...tenant, scopes: ['admin'] })
    secret = (await addWebhookEndpoint(config, tenant, { url })).secret!
    server = createServer(config, { onError: () => {} })
    await server.start()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
    await new Promise((r) => receiver?.close(r))
  })

  it('classifies with the fake LLM, keeps the evidence on disk and posts a signed webhook to a local receiver', async () => {
    const post = await call(installed.liveKey, '/flagging/reports', {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: 'u_john_doe' }, category: 'asking_for_money', evidence: { kind: 'message', content: ['invest in my crypto coin'] } },
    })
    expect(post.status).toBe(202)
    const reportId = ((await post.json()) as { id: string }).id
    const caseId = await eventually(async () => ((await got(installed.liveKey, `/flagging/reports/${reportId}`))?.case_id as string | null) ?? undefined)
    const c = await eventually(async () => {
      const now = await got(admin.key, `/moderation/cases/${caseId}`)
      return now && now.state !== 'classifying' ? now : undefined
    })
    expect(c).toMatchObject({ state: 'open', classified_by: 'llm', category_id: 'scams_fraud.investment_scam' })
    expect(await got(admin.key, `/classify/classifications/${caseId}`)).toMatchObject({ summary: 'Fake classification of 1 message(s).' })

    const hook = await eventually(() => hooks.find((h) => h.body.includes('"report.triaged"')))
    expect(verify(secret, hook.headers, hook.body).ok).toBe(true)
    expect(JSON.parse(hook.body)).toMatchObject({ data: { case_id: caseId, classified_by: 'llm' } })
  })
})
