// Local development with nothing outside the machine: the built-in fake LLM, evidence on local
// disk, a master key from the environment, and the real fetch posting to a webhook receiver on
// loopback over http:. Only Postgres is needed; skipped without TEST_DATABASE_URL.
import { mkdtempSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newKeyringEntry } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { addWebhookEndpoint, bootstrap, createKey, createServer, migrateFromEnv, serverConfigFromEnv, type Bootstrapped, type Server } from '@flagwise/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually } from '../src/install.ts'
import type { Webhook } from '../src/net.ts'
import { PATHS } from '../src/paths.ts'
import { signedWith } from '../src/signature.ts'

describe.skipIf(!testDatabaseUrl)('local development with no outside service', () => {
  let t: TestDatabase
  let server: Server
  let receiver: HttpServer
  let installed: Bootstrapped
  let admin: { key: string }
  let secret: string
  const hooks: Webhook[] = []
  const call = async (key: string, path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await server.app.http.request(`/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
    return { status: res.status, body: res.ok ? ((await res.json()) as Record<string, any>) : undefined }
  }

  beforeAll(async () => {
    receiver = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body) as { type: string; data: Record<string, any> }
        hooks.push({ type: parsed.type, data: parsed.data, headers: req.headers as Record<string, string>, body })
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
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'integration-evidence-')),
      LLM_PROVIDER: 'fake',
      SECRETS_ENCRYPTION_KEY: newKeyringEntry('dev'),
      WEBHOOKS_ALLOW_HTTP: 'true',
      API_RATE_PER_SECOND: '1000',
      API_RATE_BURST: '1000',
    })
    installed = await bootstrap(config, { appName: 'Jane Doe Dating iOS' })
    const appRef = { appId: installed.app.id, livemode: true }
    admin = await createKey(config, { ...appRef, scopes: ['admin'] })
    secret = (await addWebhookEndpoint(config, appRef, { url })).secret!
    server = createServer(config, { onError: () => {} })
    await server.start()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
    await new Promise((r) => receiver?.close(r))
  })

  it('classifies with the fake LLM, keeps the evidence on disk and posts a signed webhook to a local receiver', async () => {
    const post = await call(installed.liveKey, PATHS.reports(), {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: 'u_john_doe' }, category: 'asking_for_money', evidence: { kind: 'message', content: ['invest in my crypto coin'] } },
    })
    expect(post.status).toBe(202)
    const reportId = post.body!['id'] as string
    const caseId = await eventually(async () => ((await call(installed.liveKey, PATHS.report(reportId))).body?.['case_id'] as string | null) ?? undefined, 'a case')
    const c = await eventually(async () => {
      const now = (await call(admin.key, PATHS.case(caseId))).body
      return now && now['state'] !== 'classifying' ? now : undefined
    }, 'classified')
    expect(c).toMatchObject({ state: 'open', classified_by: 'llm', category_id: 'scams_fraud.investment_scam' })
    expect((await call(admin.key, PATHS.classification(caseId))).body).toMatchObject({ summary: 'Fake classification of 1 message(s).' })
    expect((await call(admin.key, PATHS.evidence(reportId))).status).toBe(200)

    const hook = await eventually(() => hooks.find((h) => h.type === 'report.triaged'), 'report.triaged')
    expect(signedWith(secret, hook)).toBe(true)
    expect(hook.data).toMatchObject({ case_id: caseId, classified_by: 'llm' })
  })
})
