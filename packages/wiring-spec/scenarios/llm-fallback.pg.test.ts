// Scenario 2: the LLM fails, the case is classified by rules (or waits untriaged when the fallback
// is off), and the LLM retry about 5 minutes later re-triages it, but only while no moderator has
// claimed it. The clock skips ahead instead of waiting. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { EVENTS, PATHS } from '../src/paths.ts'
import { caseWhen, claim, triagedCase } from '../src/steps.ts'

const MINUTE = 60_000
/** Past the first retry wait: 5 minutes, jittered by up to 20%. */
const PAST_FIRST_RETRY = 6.5 * MINUTE

describe.skipIf(!testDatabaseUrl)('the LLM failing and coming back', () => {
  let i: Install
  const reclassified = async (caseId: string) =>
    eventually(async () => ((await i.facts()).some((f) => f.type === EVENTS.caseReclassified && f.key === caseId) ? true : undefined), `${caseId} reclassified`)

  beforeAll(async () => {
    i = await startInstall('llm-fallback')
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('falls back to rules, then re-triages an unclaimed case with the LLM and leaves a claimed one alone', async () => {
    i.net.llm = () => 'down'
    const open = await triagedCase(i, { reported: 'u_jack_doe' })
    const held = await triagedCase(i, { reported: 'u_jim_doe' })
    expect(open).toMatchObject({ state: 'open', classified_by: 'rules' })
    await claim(i, i.jane, held.id)

    i.net.llm = () => ({ category_id: 'scams_fraud.investment_scam' })
    const calls = i.net.llmCalls()
    i.clock.advance(PAST_FIRST_RETRY)

    const retried = await caseWhen(i, open.id, (c) => c.classified_by === 'llm', 'classified by the LLM')
    expect(retried).toMatchObject({ state: 'open', category_id: 'scams_fraud.investment_scam' })
    expect(i.net.llmCalls()).toBeGreaterThan(calls)

    await reclassified(held.id)
    const kept = (await i.call(i.jane.key, PATHS.case(held.id))).body
    expect(kept).toMatchObject({ state: 'claimed', classified_by: 'rules', category_id: held.category_id, triage: { severity: held.triage.severity } })
  })

  it('leaves the case untriaged without the fallback, and triages it once the LLM answers', async () => {
    expect((await i.call(i.jane.key, PATHS.llmSettings(), { method: 'PUT', body: { rules_only: false, fallback_to_rules: false } })).status).toBe(200)
    i.net.llm = () => 'down'
    const waiting = await triagedCase(i, { reported: 'u_joe_doe' })
    expect(waiting).toMatchObject({ state: 'untriaged', triage: null })

    i.net.llm = () => ({ category_id: 'scams_fraud.investment_scam' })
    i.clock.advance(PAST_FIRST_RETRY)
    const triaged = await caseWhen(i, waiting.id, (c) => c.state === 'open', 'open')
    expect(triaged).toMatchObject({ classified_by: 'llm', category_id: 'scams_fraud.investment_scam' })
    expect(triaged.triage.severity).toMatch(/^P[012]$/)
  })
})
