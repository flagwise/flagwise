// An app's categories and LLM settings with the server's own wiring on a real Postgres: the config
// endpoints, the report screen, and what they do to classification and triage. The install's LLM
// always fails here, so the fallback decides. Skipped without TEST_DATABASE_URL.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifierPrompt, LlmError, type LlmProvider } from '@flagwise/classify'
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

const HOUR = 3_600_000

describe.skipIf(!testDatabaseUrl)('app categories and LLM settings on the server', () => {
  let t: TestDatabase
  let config: ServerConfig
  let server: Server
  let installed: Bootstrapped
  let admin: { key: string; id: string }
  let llmCalls = 0
  const failing: LlmProvider = {
    async complete() {
      llmCalls++
      throw new LlmError({ kind: 'server' }, 'The provider is down')
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
  const caseFor = async (reported: string, category: string) => {
    const res = await call(installed.liveKey, '/flagging/reports', {
      method: 'POST',
      body: { reporter: { external_id: 'u_jane_doe' }, reported: { external_id: reported }, category, evidence: { kind: 'message', content: ['send me $200'] } },
    })
    const reportId = (await json(res)).id as string
    const caseId = await eventually(async () => ((await got(installed.liveKey, `/flagging/reports/${reportId}`))?.case_id as string | null) ?? undefined)
    return eventually(async () => {
      const c = await got(admin.key, `/moderation/cases/${caseId}`)
      return c === undefined || c.state === 'classifying' ? undefined : c
    })
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrateFromEnv({ DATABASE_OWNER_URL: t.ownerUrl, DATABASE_APP_URL: `postgres://${t.roles.app}@x/x`, DATABASE_SYSTEM_URL: `postgres://${t.roles.system}@x/x` })
    const base = await serverConfigFromEnv({ DATABASE_APP_URL: t.appUrl, DATABASE_SYSTEM_URL: t.systemUrl, STORAGE_DIR: mkdtempSync(join(tmpdir(), 'evidence-')) })
    config = { ...base, llm: { ...base.llm, llm: { provider: failing, model: 'small', escalationModel: 'strong', prompt: classifierPrompt('You classify user reports.') } } }
    installed = await bootstrap(config, { orgName: 'Jane Doe Dating', appName: 'Jane Doe Dating iOS', preset: 'dating' })
    admin = await createKey(config, { ...tenant(), scopes: ['admin'] })
    server = createServer(config, { onError: () => {} })
    await server.start()
  })
  afterAll(async () => {
    await server?.stop()
    await t?.drop()
  })

  it('starts from the preset, serves the report screen and replaces the list', async () => {
    const preset = await json(await call(admin.key, '/policy/categories/definitions'))
    expect(preset.data.map((c: { key: string }) => c.key)).toEqual([
      'fake_profile',
      'asking_for_money',
      'rude_or_harassing',
      'sexual_content',
      'might_be_underage',
      'threatening_or_dangerous',
      'problem_meeting_up',
      'spam_or_selling',
      'other',
    ])
    expect(preset.warnings).toEqual([])
    const screen = await json(await call(installed.liveKey, '/policy/categories/menu?locale=id'))
    expect(screen.data[1]).toEqual({ object: 'category', key: 'asking_for_money', label: 'Minta uang atau penipuan' })
    expect((await call(installed.liveKey, '/policy/categories/menu?locale=fr')).status).toBe(422)
    // The test mode got the preset too.
    expect((await json(await call(installed.testKey, '/policy/categories/menu'))).data).toHaveLength(9)

    expect((await call(installed.liveKey, '/policy/categories/definitions', { method: 'PUT', body: { preset: 'community' } })).status).toBe(403)
    expect((await call(admin.key, '/policy/categories/definitions', { method: 'PUT', body: { preset: 'gaming' } })).status).toBe(422)
    const bad = await call(admin.key, '/policy/categories/definitions', { method: 'PUT', body: { data: [{ key: 'grooming', label: { en: 'Grooming' }, maps_to: ['child_safety.grooming'], severity: 'P2' }] } })
    expect(bad.status).toBe(422)

    const replaced = await json(
      await call(admin.key, '/policy/categories/definitions', {
        method: 'PUT',
        body: {
          data: [
            { key: 'asking_for_money', label: { en: 'Asking for money', id: 'Minta uang' }, maps_to: ['scams_fraud.romance_scam'], severity: 'P2', sla_hours: 6 },
            { key: 'rude_or_harassing', label: { en: 'Rude or harassing' }, maps_to: ['harassment', 'hate_speech'] },
            { key: 'house_rules', label: { en: 'Breaks our house rules' }, enabled: false },
          ],
        },
      }),
    )
    expect(replaced.data[0]).toEqual({
      object: 'category',
      key: 'asking_for_money',
      label: { en: 'Asking for money', id: 'Minta uang' },
      maps_to: ['scams_fraud.romance_scam'],
      severity: 'P2',
      sla_hours: 6,
      enabled: true,
    })
    expect(replaced.warnings).toEqual([{ key: 'house_rules', message: 'Not mapped to a global category: left out of the DSA export and counted as Other' }])
    expect((await json(await call(installed.liveKey, '/policy/categories/menu'))).data.map((c: { key: string }) => c.key)).toEqual(['asking_for_money', 'rude_or_harassing'])
    // The readers' copies of the policy follow over the bus; the next tests classify with them.
    await eventually(async () => ((await server.bus.pending()) === 0 ? true : undefined))
  })

  it('lists the global taxonomy and the presets for admin keys only', async () => {
    const taxonomy = await json(await call(admin.key, '/policy/taxonomy'))
    expect(taxonomy.groups).toContain('child_safety')
    expect(taxonomy.data).toContainEqual({ object: 'global_category', id: 'child_safety.grooming', group: 'child_safety', label: 'Grooming or sexual enticement of a minor', severity: 'P0', p0_locked: true })
    expect(taxonomy.data).toContainEqual(expect.objectContaining({ id: 'threats_violence.graphic_violence', severity: 'P2', p0_locked: false }))
    const presets = await json(await call(admin.key, '/policy/presets'))
    expect(presets.data.map((p: { name: string }) => p.name)).toEqual(['dating', 'marketplace', 'community'])
    expect(presets.data[0].categories[0]).toEqual({ object: 'category', key: 'fake_profile', label: { en: 'Fake profile', id: 'Profil palsu' }, maps_to: ['fake_identity'], severity: null, sla_hours: null, enabled: true })
    expect((await call(installed.liveKey, '/policy/taxonomy')).status).toBe(403)
    expect((await call(installed.liveKey, '/policy/presets')).status).toBe(403)
  })

  it("falls back to rules when the LLM fails, and triages with the app's category", async () => {
    expect(await json(await call(admin.key, '/policy/llm-settings'))).toEqual({ object: 'llm_settings', rules_only: false, fallback_to_rules: true })
    const before = llmCalls
    const c = await caseFor('u_jack_doe', 'asking_for_money')
    expect(llmCalls).toBeGreaterThan(before)
    expect(c).toMatchObject({ state: 'open', classified_by: 'rules', category_id: 'scams_fraud.romance_scam', custom_category_id: 'asking_for_money', triage: { severity: 'P2' } })
    expect(Date.parse(c.triage.sla_due_at) - Date.parse(c.opened_at)).toBe(6 * HOUR)

    // A label for several categories: other, at the least severe of them.
    expect(await caseFor('u_jim_doe', 'rude_or_harassing')).toMatchObject({ category_id: 'other', custom_category_id: 'rude_or_harassing', triage: { severity: 'P1' } })
    // A pick the app does not have.
    expect(await caseFor('u_joe_doe', 'made_up')).toMatchObject({ category_id: 'other', custom_category_id: null, triage: { severity: 'P2', flags: ['other_category', 'reported_age_unknown'] } })
  })

  it('never calls the LLM for a rules-only app', async () => {
    expect((await call(admin.key, '/policy/llm-settings', { method: 'PUT', body: { rules_only: 'yes' } })).status).toBe(422)
    expect(await json(await call(admin.key, '/policy/llm-settings', { method: 'PUT', body: { rules_only: true, fallback_to_rules: false } }))).toEqual({
      object: 'llm_settings',
      rules_only: true,
      fallback_to_rules: false,
    })
    const before = llmCalls
    expect(await caseFor('u_jeff_doe', 'asking_for_money')).toMatchObject({ state: 'open', classified_by: 'rules', triage: { severity: 'P2' } })
    expect(llmCalls).toBe(before)
  })

  it('leaves the case untriaged when the LLM fails and the fallback is off, for a moderator to triage', async () => {
    await call(admin.key, '/policy/llm-settings', { method: 'PUT', body: { rules_only: false, fallback_to_rules: false } })
    const c = await caseFor('u_jay_doe', 'asking_for_money')
    expect(c).toMatchObject({ state: 'untriaged', triage: null, category_id: 'scams_fraud.romance_scam', custom_category_id: 'asking_for_money' })
    const queue = await json(await call(admin.key, '/moderation/cases'))
    expect(queue.data.at(-1)).toMatchObject({ id: c.id, state: 'untriaged' })

    expect((await call(admin.key, `/moderation/cases/${c.id}/claim`, { method: 'POST' })).status).toBe(200)
    const asked = await json(await call(admin.key, `/moderation/cases/${c.id}`, { method: 'PATCH', body: { category_id: 'scams_fraud.romance_scam' } }))
    expect(asked).toMatchObject({ state: 'claimed', triage: null, custom_category_id: 'asking_for_money' })
    // Triage triages it from the correction, with the app's category's own severity.
    const triaged = await eventually(async () => {
      const now = await got(admin.key, `/moderation/cases/${c.id}`)
      return now?.triage ? now : undefined
    })
    expect(triaged).toMatchObject({ state: 'claimed', triage: { severity: 'P2' }, custom_category_id: 'asking_for_money' })

    const timeline = await eventually(async () => {
      const page = await got(admin.key, `/audit/entries?case_id=${c.id}`)
      return page?.data.some((e: { action: string }) => e.action === 'case.corrected') ? page.data : undefined
    })
    expect(timeline.find((e: { action: string }) => e.action === 'case.untriaged')).toMatchObject({ facts: { reason: 'provider_error' } })
    expect(timeline.find((e: { action: string }) => e.action === 'case.corrected')).toMatchObject({ facts: { before: { severity: null } } })
  })
})
