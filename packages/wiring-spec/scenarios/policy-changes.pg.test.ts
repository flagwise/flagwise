// Scenario 7: the app's categories, action keys and LLM setting take effect on new cases: a custom
// category's severity and SLA, the action keys a decision may use, and a rules-only app never
// calling the LLM. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall, type Install } from '../src/install.ts'
import { PATHS } from '../src/paths.ts'
import { claim, setActionKeys, triagedCase } from '../src/steps.ts'

const HOUR = 3_600_000

describe.skipIf(!testDatabaseUrl)('policy changes', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall('policy-changes')
    i.net.llm = () => 'down'
  })
  afterAll(async () => {
    await i?.stop()
  })

  it("triages new cases with the app's category, its severity and its SLA", async () => {
    const replaced = await i.call(i.jane.key, PATHS.categories(), {
      method: 'PUT',
      body: { data: [{ key: 'asking_for_money', label: { en: 'Asking for money' }, maps_to: ['scams_fraud.romance_scam'], severity: 'P2', sla_hours: 6 }] },
    })
    expect(replaced.status).toBe(200)
    const c = await triagedCase(i, { reported: 'u_jack_doe', category: 'asking_for_money' })
    expect(c).toMatchObject({ category_id: 'scams_fraud.romance_scam', custom_category_id: 'asking_for_money', triage: { severity: 'P2' } })
    expect(Date.parse(c.triage.sla_due_at) - Date.parse(c.opened_at)).toBe(6 * HOUR)
  })

  it('lets a decision use only the action keys the category allows', async () => {
    await setActionKeys(i, [
      { key: 'warn', label: { en: 'Warn' }, categories: ['*'] },
      { key: 'mute_chat', label: { en: 'Mute chat' }, categories: ['harassment'] },
    ])
    const c = await triagedCase(i, { reported: 'u_jim_doe', category: 'asking_for_money' })
    await claim(i, i.jane, c.id)
    const decide = (keys: string[]) =>
      i.call(i.jane.key, PATHS.decision(c.id), { method: 'POST', body: { outcome: 'violation', category_id: c.category_id, severity: c.triage.severity, action_keys: keys, report_ids: [c.reportId] } })
    expect((await decide(['mute_chat'])).status).toBe(422)
    expect((await decide(['warn'])).status).toBe(201)
  })

  it('never calls the LLM for a rules-only app', async () => {
    expect((await i.call(i.jane.key, PATHS.llmSettings(), { method: 'PUT', body: { rules_only: true, fallback_to_rules: false } })).status).toBe(200)
    const calls = i.net.llmCalls()
    expect(await triagedCase(i, { reported: 'u_joe_doe', category: 'asking_for_money' })).toMatchObject({ state: 'open', classified_by: 'rules', triage: { severity: 'P2' } })
    expect(i.net.llmCalls()).toBe(calls)
  })
})
