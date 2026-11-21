// Scenario 7: the app's policy (its categories from a preset, its action keys, its LLM settings)
// as an admin sets it, and what it does to the report screen, to triage and to decisions. The LLM
// is down throughout, so rules decide. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { createKey } from '@flagwise/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { PATHS } from '../src/paths.ts'
import { claim, setActionKeys, triagedCase } from '../src/steps.ts'

const HOUR = 3_600_000
const DATING = ['fake_profile', 'asking_for_money', 'rude_or_harassing', 'sexual_content', 'might_be_underage', 'threatening_or_dangerous', 'problem_meeting_up', 'spam_or_selling', 'other']

describe.skipIf(!testDatabaseUrl)('policy changes', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall({ preset: 'dating' })
    i.net.llm = () => 'down'
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('starts the app from its preset and serves the report screen in its languages', async () => {
    const preset = await i.call(i.jane.key, PATHS.categories())
    expect(preset.body.data.map((c: { key: string }) => c.key)).toEqual(DATING)
    expect(preset.body.warnings).toEqual([])
    const screen = await i.call(i.flaggingKey, PATHS.menu('id'))
    expect(screen.body.data[1]).toEqual({ object: 'category', key: 'asking_for_money', label: 'Minta uang atau penipuan' })
    expect((await i.call(i.flaggingKey, PATHS.menu('fr'))).status).toBe(422)
    // The test mode got the preset too.
    expect((await i.call(i.testKey, PATHS.menu())).body.data).toHaveLength(DATING.length)
  })

  it('lists the global taxonomy and the presets for admin keys only', async () => {
    const taxonomy = (await i.call(i.jane.key, PATHS.taxonomy())).body
    expect(taxonomy.groups).toContain('child_safety')
    expect(taxonomy.data).toContainEqual({ object: 'global_category', id: 'child_safety.grooming', group: 'child_safety', label: 'Grooming or sexual enticement of a minor', severity: 'P0', p0_locked: true })
    const presets = (await i.call(i.jane.key, PATHS.presets())).body
    expect(presets.data.map((p: { name: string }) => p.name)).toEqual(['dating', 'marketplace', 'community'])
    expect(presets.data[0].categories[0]).toEqual({ object: 'category', key: 'fake_profile', label: { en: 'Fake profile', id: 'Profil palsu' }, maps_to: ['fake_identity'], severity: null, sla_hours: null, enabled: true })
    expect((await i.call(i.flaggingKey, PATHS.taxonomy())).status).toBe(403)
    expect((await i.call(i.flaggingKey, PATHS.presets())).status).toBe(403)
  })

  it("replaces the app's categories, and triages new cases with them", async () => {
    expect((await i.call(i.flaggingKey, PATHS.categories(), { method: 'PUT', body: { preset: 'community' } })).status).toBe(403)
    expect((await i.call(i.jane.key, PATHS.categories(), { method: 'PUT', body: { preset: 'gaming' } })).status).toBe(422)
    // A P0 category's severity is fixed.
    expect((await i.call(i.jane.key, PATHS.categories(), { method: 'PUT', body: { data: [{ key: 'grooming', label: { en: 'Grooming' }, maps_to: ['child_safety.grooming'], severity: 'P2' }] } })).status).toBe(422)
    const replaced = await i.call(i.jane.key, PATHS.categories(), {
      method: 'PUT',
      body: {
        data: [
          { key: 'asking_for_money', label: { en: 'Asking for money', id: 'Minta uang' }, maps_to: ['scams_fraud.romance_scam'], severity: 'P2', sla_hours: 6 },
          { key: 'rude_or_harassing', label: { en: 'Rude or harassing' }, maps_to: ['harassment', 'hate_speech'] },
          { key: 'house_rules', label: { en: 'Breaks our house rules' }, enabled: false },
        ],
      },
    })
    expect(replaced.status).toBe(200)
    expect(replaced.body.data[0]).toEqual({ object: 'category', key: 'asking_for_money', label: { en: 'Asking for money', id: 'Minta uang' }, maps_to: ['scams_fraud.romance_scam'], severity: 'P2', sla_hours: 6, enabled: true })
    expect(replaced.body.warnings).toEqual([{ key: 'house_rules', message: 'Not mapped to a global category: left out of the DSA export and counted as Other' }])
    // The report screen shows only the enabled ones.
    expect((await i.call(i.flaggingKey, PATHS.menu())).body.data.map((c: { key: string }) => c.key)).toEqual(['asking_for_money', 'rude_or_harassing'])

    // Triage reads the change once its copy of the policy has it.
    const c = await eventually(async () => {
      const now = await triagedCase(i, { reported: `u_jack_doe_${Date.now()}`, category: 'asking_for_money' })
      return now.custom_category_id === 'asking_for_money' ? now : undefined
    }, "a case triaged with the app's category")
    expect(c).toMatchObject({ classified_by: 'rules', category_id: 'scams_fraud.romance_scam', triage: { severity: 'P2' } })
    expect(Date.parse(c.triage.sla_due_at) - Date.parse(c.opened_at)).toBe(6 * HOUR)
    // A label for several categories: other, at the least severe of them.
    expect(await triagedCase(i, { reported: 'u_jim_doe', category: 'rude_or_harassing' })).toMatchObject({ category_id: 'other', custom_category_id: 'rude_or_harassing', triage: { severity: 'P1' } })
    // A pick the app does not have.
    expect(await triagedCase(i, { reported: 'u_joe_doe', category: 'made_up' })).toMatchObject({ category_id: 'other', custom_category_id: null, triage: { severity: 'P2', flags: ['other_category', 'reported_age_unknown'] } })
  })

  it('keeps action keys as an admin sets them, each mode its own, and lets a decision use only those its category allows', async () => {
    const keys = [
      { key: 'warn', label: { en: 'Warn' }, categories: ['*'] },
      { key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, reverse_key: 'unsuspend', categories: ['scams_fraud'] },
      { key: 'unsuspend', label: { en: 'Lift suspension' }, categories: ['*'] },
      { key: 'mute_chat', label: { en: 'Mute chat' }, categories: ['harassment'] },
    ]
    expect((await i.call(i.flaggingKey, PATHS.actionKeys())).status).toBe(403)
    expect((await i.call(i.flaggingKey, PATHS.actionKeys(), { method: 'PUT', body: { data: keys } })).status).toBe(403)
    // A reverse key must be one of the list.
    const bad = await i.call(i.jane.key, PATHS.actionKeys(), { method: 'PUT', body: { data: [keys[1]] } })
    expect(bad.status).toBe(422)
    expect(bad.body).toMatchObject({ errors: [{ path: 'data[0].reverse_key' }] })

    await setActionKeys(i, keys)
    const listed = (await i.call(i.jane.key, PATHS.actionKeys())).body
    expect(listed.data[1]).toEqual({ object: 'action_key', key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: null, reverse_key: 'unsuspend', auto_allowed: false, categories: ['scams_fraud'] })
    const testAdmin = await createKey(i.config, { ...i.appRef, livemode: false, scopes: ['admin'] })
    expect((await i.call(testAdmin.key, PATHS.actionKeys())).body.data).toEqual([])

    const c = await triagedCase(i, { reported: 'u_jeff_doe', category: 'asking_for_money' })
    await claim(i, i.jane, c.id)
    const decide = (actionKeys: string[]) =>
      i.call(i.jane.key, PATHS.decision(c.id), { method: 'POST', body: { outcome: 'violation', category_id: c.category_id, severity: c.triage.severity, action_keys: actionKeys, report_ids: [c.reportId] } })
    expect((await decide(['mute_chat'])).status).toBe(422)
    expect((await decide(['suspend_7d'])).status).toBe(201)

    // A removed key is no longer listed.
    await setActionKeys(i, [keys[0]])
    expect((await i.call(i.jane.key, PATHS.actionKeys())).body.data.map((k: { key: string }) => k.key)).toEqual(['warn'])
  })

  it('never calls the LLM for a rules-only app', async () => {
    expect((await i.call(i.jane.key, PATHS.llmSettings())).body).toEqual({ object: 'llm_settings', rules_only: false, fallback_to_rules: true })
    expect((await i.call(i.jane.key, PATHS.llmSettings(), { method: 'PUT', body: { rules_only: 'yes' } })).status).toBe(422)
    expect((await i.call(i.jane.key, PATHS.llmSettings(), { method: 'PUT', body: { rules_only: true, fallback_to_rules: false } })).body).toEqual({ object: 'llm_settings', rules_only: true, fallback_to_rules: false })
    // Classify reads the change once its copy of the policy has it; from then on no case calls the LLM.
    const c = await eventually(async () => {
      const calls = i.net.llmCalls()
      const now = await triagedCase(i, { reported: `u_joe_doe_${Date.now()}`, category: 'asking_for_money' })
      return i.net.llmCalls() === calls ? now : undefined
    }, 'a case triaged without calling the LLM')
    expect(c).toMatchObject({ state: 'open', classified_by: 'rules', triage: { severity: 'P2' } })
  })
})
