// Scenario 5: a moderator corrects a claimed case; its severity follows the correction at once and
// its priority and SLA once triage has triaged it again, P0 is never lowered, and the correction is
// on the case's audit trail. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { PATHS } from '../src/paths.ts'
import { claim, triagedCase } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('correcting a case', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall()
    i.net.llm = () => ({ category_id: 'scams_fraud.investment_scam' })
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('re-triages a claimed case after a correction and keeps P0 from being lowered', async () => {
    const c = await triagedCase(i, { reported: 'u_jack_doe' })
    expect(c.triage.severity).not.toBe('P0')

    // Only the moderator holding the claim may correct.
    expect((await i.call(i.jane.key, PATHS.case(c.id), { method: 'PATCH', body: { severity: 'P0' } })).status).toBe(409)
    await claim(i, i.jane, c.id)
    expect((await i.call(i.john.key, PATHS.case(c.id), { method: 'PATCH', body: { severity: 'P0' } })).status).toBe(409)

    const corrected = await i.call(i.jane.key, PATHS.case(c.id), { method: 'PATCH', body: { category_id: 'scams_fraud.romance_scam', severity: 'P0' } })
    expect(corrected.status).toBe(200)
    expect(corrected.body).toMatchObject({ state: 'claimed', category_id: 'scams_fraud.romance_scam', triage: { severity: 'P0' } })
    await eventually(async () => {
      const now = (await i.call(i.jane.key, PATHS.case(c.id))).body
      return Date.parse(now?.triage?.sla_due_at) < Date.parse(c.triage.sla_due_at) ? now : undefined
    }, 'the SLA of the corrected severity')

    expect((await i.call(i.jane.key, PATHS.case(c.id), { method: 'PATCH', body: { severity: 'P2' } })).status).toBe(422)
    expect((await i.call(i.jane.key, PATHS.case(c.id), { method: 'PATCH', body: { category_id: 'made_up' } })).status).toBe(422)

    const trail = await eventually(async () => {
      const page = (await i.call(i.jane.key, PATHS.audit(c.id))).body
      return page?.data?.some((e: { action: string }) => e.action === 'case.corrected') ? page.data : undefined
    }, 'the correction on the audit trail')
    expect(trail.find((e: { action: string }) => e.action === 'case.corrected')).toMatchObject({ facts: { before: { severity: c.triage.severity } } })
  })
})
