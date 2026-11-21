// People hear of what needs them: a P0 case until someone claims it, a case nearing or past its
// SLA until it is decided. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { PATHS } from '../src/paths.ts'
import { claim, triagedCase } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('notifications', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall()
    expect((await i.call(i.jane.key, PATHS.llmSettings(), { method: 'PUT', body: { rules_only: true, fallback_to_rules: true } })).status).toBe(200)
  })
  afterAll(async () => {
    await i?.stop()
  })

  /** The notifications in `states` about `caseId`, once `check` holds for them. */
  const about = (caseId: string, states: string, check: (n: readonly Record<string, any>[]) => boolean, what: string) =>
    eventually(async () => {
      const res = await i.call(i.jane.key, PATHS.notifications(states))
      if (res.status !== 200) return undefined
      const found = (res.body.data as Record<string, any>[]).filter((n) => n.values.case_id === caseId)
      return check(found) ? found : undefined
    }, `${caseId}: ${what}`)

  it('tells of a P0 case until someone claims it', async () => {
    const c = await triagedCase(i, { reported: 'u_jack_doe', category: 'harassment', text: 'i know where you live and you are dead' })
    const [p0] = await about(c.id, 'open', (n) => n.some((x) => x.type === 'new_p0'), 'new_p0 open')
    expect(p0).toMatchObject({ object: 'notification', type: 'new_p0', state: 'open', resolved_at: null })

    // Seeing it does not resolve it: only the claim does.
    expect((await i.call(i.john.key, PATHS.acknowledge(p0!.id), { method: 'POST' })).body).toMatchObject({ state: 'acknowledged' })
    await claim(i, i.jane, c.id)
    const [done] = await about(c.id, 'resolved', (n) => n.some((x) => x.type === 'new_p0'), 'new_p0 resolved')
    expect(done).toMatchObject({ id: p0!.id, resolved_by: 'case.claimed' })
  })

  it('warns at 75% of the SLA and at its breach, until the case is decided', async () => {
    const c = await triagedCase(i, { reported: 'u_jim_doe' })
    const left = new Date(c.triage.sla_due_at).getTime() - i.clock.now().getTime()
    i.clock.advance(left + 1)
    const raised = await about(c.id, 'open', (n) => n.length === 2, 'SLA warning and breach open')
    expect(raised.map((n) => n.type).sort()).toEqual(['sla_75', 'sla_breach'])

    await claim(i, i.jane, c.id)
    const decided = await i.call(i.jane.key, PATHS.decision(c.id), { method: 'POST', body: { outcome: 'no_violation', category_id: c.category_id, severity: c.triage.severity, action_keys: [], report_ids: [c.reportId] } })
    expect(decided.status).toBe(201)
    const resolved = await about(c.id, 'resolved', (n) => n.length === 2, 'SLA notifications resolved')
    expect(resolved.every((n) => n.resolved_by === 'case.decided')).toBe(true)
  })
})
