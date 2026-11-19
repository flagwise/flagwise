// The install paths on a real Postgres, with separate role URLs (db:init, db:migrate, bootstrap) and
// with one DATABASE_URL (bootstrap alone), then a report through the API and the event handlers with
// the server's own wiring. Skipped without TEST_DATABASE_URL.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgCaseRepository } from '@flagwise/moderation'
import { scopeOfRef, withTenant } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { bootstrap, createKey, createServer, initDatabaseFromEnv, migrateFromEnv, serverConfigFromEnv, type Bootstrapped, type Server } from '../src/index.ts'

/** Sends a report from the key, runs the handlers, and returns the case it landed in. */
async function reportToCase(server: Server, installed: Bootstrapped) {
  const post = await server.app.http.request('/v1/flagging/reports', {
    method: 'POST',
    headers: { authorization: `Bearer ${installed.liveKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      reporter: { external_id: 'u_jane_doe' },
      reported: { external_id: 'u_john_doe' },
      category: 'asking_for_money',
      text: 'He asked me to send $200 first',
      evidence: { kind: 'message', content: ['can you send me $200 first?'] },
    }),
  })
  expect(post.status).toBe(202)
  const { id } = (await post.json()) as { id: string }
  await server.bus.drain()

  const get = await server.app.http.request(`/v1/flagging/reports/${id}`, { headers: { authorization: `Bearer ${installed.liveKey}` } })
  const report = (await get.json()) as { status: string; case_id: string }
  expect(report.status).toBe('assigned')
  const tenant = { orgId: installed.org.id, appId: installed.app.id, livemode: true }
  return withTenant(server.db, scopeOfRef(tenant), (tx) => pgCaseRepository(tx).findById(tenant, report.case_id))
}

describe.skipIf(!testDatabaseUrl)('the install path on Postgres', () => {
  let t: TestDatabase
  let env: Record<string, string>
  let installed: Bootstrapped
  let server: Server

  beforeAll(async () => {
    t = await createTestDatabase()
    env = {
      DATABASE_ADMIN_URL: testDatabaseUrl!,
      DATABASE_OWNER_URL: t.ownerUrl,
      DATABASE_APP_URL: t.appUrl,
      DATABASE_SYSTEM_URL: t.systemUrl,
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')),
    }
    // The roles exist already; db:init is safe to run again over them.
    await initDatabaseFromEnv(env)
    expect((await migrateFromEnv(env)).length).toBeGreaterThan(0)
    expect(await migrateFromEnv(env)).toEqual([])
    const config = await serverConfigFromEnv(env)
    installed = await bootstrap(config, { orgName: 'Jane Doe Dating', appName: 'Jane Doe Dating iOS' })
    server = createServer(config)
    expect((await server.app.http.request('/readyz')).status).toBe(503)
    await server.prepare()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('needs the three role URLs on one database', async () => {
    await expect(initDatabaseFromEnv({ ...env, DATABASE_APP_URL: env.DATABASE_APP_URL!.replace(t.database, 'other') })).rejects.toThrow('must point at the same database')
    await expect(migrateFromEnv({ ...env, DATABASE_OWNER_URL: undefined })).rejects.toThrow('Set DATABASE_OWNER_URL or DATABASE_URL')
  })

  it('is ready, and takes a report from a bootstrapped key to a triaged case, by rules without an LLM', async () => {
    expect(installed).toMatchObject({ org: { name: 'Jane Doe Dating' }, app: { name: 'Jane Doe Dating iOS' } })
    expect(installed.liveKey).toMatch(/^fw_live_/)
    expect(installed.testKey).toMatch(/^fw_test_/)
    expect((await server.app.http.request('/readyz')).status).toBe(200)

    const opened = await reportToCase(server, installed)
    // The reporter's own category is outside the taxonomy, so triage treats it as other.
    expect(opened).toMatchObject({ state: 'open', triage: { severity: 'P2' } })
    expect(await server.bus.deadLetters()).toEqual([])
  })
})

describe.skipIf(!testDatabaseUrl)('a server deployed before its migrations', () => {
  let t: TestDatabase
  let server: Server
  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('serves with /readyz at 503 and waits, then starts once a migration job with only the owner URL has run', async () => {
    const env = { DATABASE_APP_URL: t.appUrl, DATABASE_SYSTEM_URL: t.systemUrl, STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')) }
    const waiting: string[] = []
    server = createServer(await serverConfigFromEnv(env), { retryMs: 20, onWaiting: (reason) => waiting.push(reason) })
    let started = false
    const start = server.start().then(() => (started = true))
    await expect.poll(() => waiting.length).toBeGreaterThan(0)
    expect(waiting[0]).toMatch(/not applied yet.*run db:migrate/)
    expect((await server.app.http.request('/healthz')).status).toBe(200)
    expect((await server.app.http.request('/readyz')).status).toBe(503)
    expect(started).toBe(false)
    await expect(server.prepare()).rejects.toThrow(/run db:migrate/)

    // The job knows the role names from the defaults; these test roles have their own names.
    const roleNames = { DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` }
    expect((await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, ...roleNames })).length).toBeGreaterThan(0)
    await start
    expect((await server.app.http.request('/readyz')).status).toBe(200)
    // Reported again only when the reason changed (the count, while the job ran).
    for (const reason of waiting) expect(reason).toMatch(/run db:migrate/)
    expect(new Set(waiting).size).toBe(waiting.length)
  })

  it('stops while waiting', async () => {
    const other = await createTestDatabase()
    try {
      const s = createServer(await serverConfigFromEnv({ DATABASE_APP_URL: other.appUrl, DATABASE_SYSTEM_URL: other.systemUrl }), { retryMs: 20, onWaiting: () => {} })
      const start = expect(s.start()).rejects.toThrow('Stopped before the database was ready')
      await s.stop()
      await start
    } finally {
      await other.drop()
    }
  })
})

describe.skipIf(!testDatabaseUrl)('the install path with one DATABASE_URL', () => {
  // The official Postgres image's user: a superuser, here on a fresh database (its test roles go unused).
  let t: TestDatabase
  let server: Server

  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('bootstraps on an empty database, and runs every query as the app or system role', async () => {
    const url = new URL(testDatabaseUrl!)
    url.pathname = `/${t.database}`
    const config = await serverConfigFromEnv({ DATABASE_URL: url.toString(), STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')) })
    expect(config.database.setup).toBe('single')

    const installed = await bootstrap(config, { orgName: 'Jane Doe Dating', appName: 'Jane Doe Dating iOS' })
    server = createServer(config)
    // prepare, not start: a polling loop would race the drain below.
    await server.prepare()
    expect((await server.app.http.request('/readyz')).status).toBe(200)
    expect(await reportToCase(server, installed)).toMatchObject({ state: 'open', triage: { severity: 'P2' } })
    expect(await server.bus.deadLetters()).toEqual([])

    expect((await server.db.app.execute(sql`SELECT current_user AS u`)).rows).toEqual([{ u: 'fw_app' }])
    expect((await server.db.system.execute(sql`SELECT current_user AS u`)).rows).toEqual([{ u: 'fw_system' }])
    // Without a tenant context, the app role sees no case even though the URL's user is a superuser.
    expect((await server.db.app.execute(sql`SELECT count(*)::int AS n FROM cases.cases`)).rows).toEqual([{ n: 0 }])
  })
})

describe.skipIf(!testDatabaseUrl)('the case API', () => {
  let t: TestDatabase
  let server: Server
  let installed: Bootstrapped
  let admin: { key: string; id: string }
  let otherAdmin: { key: string; id: string }
  const call = (key: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    server.app.http.request(`/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  const json = async (res: Response) => (await res.json()) as Record<string, any>

  beforeAll(async () => {
    t = await createTestDatabase()
    const env = { DATABASE_APP_URL: t.appUrl, DATABASE_SYSTEM_URL: t.systemUrl, STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')) }
    const roleNames = { DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` }
    await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, ...roleNames })
    const config = await serverConfigFromEnv(env)
    installed = await bootstrap(config, { orgName: 'Jane Doe Dating', appName: 'Jane Doe Dating iOS' })
    const ids = { orgId: installed.org.id, appId: installed.app.id, livemode: true }
    admin = await createKey(config, { ...ids, scopes: ['admin'] })
    otherAdmin = await createKey(config, { ...ids, scopes: ['admin'] })
    server = createServer(config)
    await server.prepare()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('needs the admin scope', async () => {
    expect((await call(installed.liveKey, '/moderation/cases')).status).toBe(403)
    expect((await call(installed.liveKey, '/classify/classifications/case_x')).status).toBe(403)
    expect((await call(installed.liveKey, '/flagging/reports/rpt_x/evidence')).status).toBe(403)
    expect((await call(admin.key, '/flagging/reports', { method: 'POST', body: {} })).status).toBe(403)
  })

  it('shows a case in the queue, its classification and evidence apart, and works it to a decision', async () => {
    const opened = await reportToCase(server, installed)
    const caseId = opened!.id
    const reportId = opened!.reportIds[0]!

    const queue = await json(await call(admin.key, '/moderation/cases'))
    expect(queue).toMatchObject({ object: 'list', next_cursor: null })
    expect(queue.data).toHaveLength(1)
    expect(queue.data[0]).toMatchObject({
      id: caseId,
      object: 'case',
      state: 'open',
      severity: 'P2',
      category_id: 'other',
      signals: [],
      classified_by: 'rules',
      report_ids: [reportId],
      report_count: 1,
      claim: null,
      decision: null,
      livemode: true,
    })
    expect(queue.data[0]).not.toHaveProperty('summary')
    expect((await json(await call(admin.key, '/moderation/cases?severity=P0'))).data).toEqual([])
    expect((await call(admin.key, '/moderation/cases?severity=P9')).status).toBe(422)

    expect(await json(await call(admin.key, `/classify/classifications/${caseId}`))).toMatchObject({
      object: 'classification',
      case_id: caseId,
      classified_by: 'rules',
      rules_reason: 'rules_only',
      summary: null,
    })
    expect(await json(await call(admin.key, `/flagging/reports/${reportId}/evidence`))).toMatchObject({
      object: 'evidence',
      report_id: reportId,
      reporter: { external_id: 'u_jane_doe' },
      reported: { external_id: 'u_john_doe' },
      text: 'He asked me to send $200 first',
      evidence: { kind: 'message', content: [{ text: 'can you send me $200 first?' }] },
    })
    expect((await call(admin.key, '/moderation/cases/case_missing')).status).toBe(404)
    expect((await call(admin.key, '/classify/classifications/case_missing')).status).toBe(404)

    const decision = { outcome: 'violation', category_id: 'scams_fraud.romance_scam', severity: 'P1', public_reason: 'Asked a match for money.' }
    expect(await json(await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision }))).toMatchObject({
      status: 409,
      detail: 'Claim the case before deciding it',
    })

    expect(await json(await call(admin.key, `/moderation/cases/${caseId}/claim`, { method: 'POST' }))).toMatchObject({ state: 'claimed', claim: { holder: admin.id } })
    expect(await json(await call(otherAdmin.key, `/moderation/cases/${caseId}/claim`, { method: 'POST' }))).toMatchObject({ status: 409, detail: `The case is claimed by ${admin.id}` })
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: { ...decision, severity: 'P5' } })).status).toBe(422)
    expect((await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: { ...decision, action_keys: ['suspend_7d'] } })).status).toBe(422)

    const decided = await call(admin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision })
    expect(decided.status).toBe(201)
    expect(await json(decided)).toMatchObject({ object: 'decision', outcome: 'violation', category_id: 'scams_fraud.romance_scam', severity: 'P1', action_keys: [], decided_by: admin.id })
    expect(await json(await call(admin.key, `/moderation/cases/${caseId}`))).toMatchObject({ state: 'actioned', claim: null, decision: { decided_by: admin.id } })
    expect((await json(await call(admin.key, '/moderation/cases'))).data).toEqual([])
    expect((await json(await call(admin.key, '/moderation/cases?state=actioned'))).data).toHaveLength(1)
    expect((await call(otherAdmin.key, `/moderation/cases/${caseId}/decision`, { method: 'POST', body: decision })).status).toBe(409)
    await server.bus.drain()
    expect(await server.bus.deadLetters()).toEqual([])
  })

  it('releases a claim, and lets an admin key force-release another key\'s claim', async () => {
    await server.app.http.request('/v1/flagging/reports', {
      method: 'POST',
      headers: { authorization: `Bearer ${installed.liveKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reporter: { external_id: 'u_jane_doe' }, reported: { external_id: 'u_jack_doe' }, category: 'spam', evidence: { kind: 'message', content: ['buy now'] } }),
    })
    await server.bus.drain()
    const [open] = (await json(await call(admin.key, '/moderation/cases'))).data
    expect(open).toMatchObject({ state: 'open', subject_external_id: 'u_jack_doe' })
    await call(admin.key, `/moderation/cases/${open.id}/claim`, { method: 'POST' })
    expect(await json(await call(otherAdmin.key, `/moderation/cases/${open.id}/release`, { method: 'POST' }))).toMatchObject({ status: 409 })
    expect(await json(await call(otherAdmin.key, `/moderation/cases/${open.id}/release`, { method: 'POST', body: { force: true } }))).toMatchObject({ state: 'open', claim: null })
    expect((await call(admin.key, `/moderation/cases/${open.id}/release`, { method: 'POST', body: { force: 'yes' } })).status).toBe(422)
  })
  it("weighs a new reported account, shows why on the case, and lists the account's cases latest first", async () => {
    const send = (reporter: Record<string, unknown>, reported: Record<string, unknown>) =>
      server.app.http.request('/v1/flagging/reports', {
        method: 'POST',
        headers: { authorization: `Bearer ${installed.liveKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reporter, reported, category: 'scams_fraud.romance_scam', evidence: { kind: 'message', content: ['send me $200 first'] } }),
      })
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
    await send({ external_id: 'u_jane_doe', account_created_at: '2025-04-11T08:00:00Z' }, { external_id: 'u_jill_doe', account_created_at: dayAgo })
    await server.bus.drain()
    const [first] = (await json(await call(admin.key, '/moderation/cases?subject_external_id=u_jill_doe'))).data
    expect(first).toMatchObject({ state: 'open', applied_rules: ['reported_new_account'], flags: [] })
    expect((await json(await call(admin.key, `/moderation/cases/${first.id}`))).priority).toBe(first.priority)

    // Once decided it stays in the account's history, and the next report opens another case.
    await call(admin.key, `/moderation/cases/${first.id}/claim`, { method: 'POST' })
    const decided = await call(admin.key, `/moderation/cases/${first.id}/decision`, { method: 'POST', body: { outcome: 'no_violation', category_id: first.category_id, severity: first.severity } })
    expect(decided.status).toBe(201)
    await send({ external_id: 'u_jim_doe' }, { external_id: 'u_jill_doe' })
    await server.bus.drain()
    const states = 'classifying,untriaged,open,claimed,decided,action_failed,actioned,closed'
    const history = await json(await call(admin.key, `/moderation/cases?subject_external_id=u_jill_doe&state=${states}&order=recent&limit=1`))
    const second = await json(await call(admin.key, `/moderation/cases?subject_external_id=u_jill_doe&state=${states}&order=recent&cursor=${history.next_cursor}`))
    expect([...history.data, ...second.data].map((c: { id: string }) => c.id)).toHaveLength(2)
    expect(second.data[0].id).toBe(first.id)
    expect(history.data[0]).toMatchObject({ applied_rules: [], flags: ['reported_age_unknown'] })
    expect((await call(admin.key, '/moderation/cases?order=newest')).status).toBe(422)
    expect((await call(admin.key, `/moderation/cases?order=urgency&cursor=${history.next_cursor}`)).status).toBe(422)
  })
})
