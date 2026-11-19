// Scenarios 1 and 6: a report becomes an LLM-classified, triaged case; a moderator claims and
// decides it; the tenant receives and confirms the action; a failed action is answered with
// another, which replaces it. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall, type Install } from '../src/install.ts'
import { EVENTS, PATHS, WEBHOOKS } from '../src/paths.ts'
import { caseWhen, claim, setActionKeys, triagedCase, webhooksOf } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('from report to action', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall('report-to-action')
    i.net.llm = () => ({ category_id: 'scams_fraud.investment_scam', confidence: 0.92 })
    await setActionKeys(i)
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('classifies and triages a report, then carries a decision to a confirmed action', async () => {
    const c = await triagedCase(i, { reported: 'u_jack_doe' })
    expect(c).toMatchObject({ state: 'open', classified_by: 'llm', category_id: 'scams_fraud.investment_scam', report_ids: [c.reportId], subject_external_id: 'u_jack_doe' })
    expect(c.triage.severity).toMatch(/^P[012]$/)
    expect(c.triage.sla_due_at).not.toBeNull()

    const [triaged] = await webhooksOf(i, WEBHOOKS.reportTriaged, (w) => w.data.case_id === c.id)
    expect(triaged!.data).toMatchObject({ case_id: c.id, category_id: 'scams_fraud.investment_scam', severity: c.triage.severity, classified_by: 'llm' })

    // The summary stays behind the classification route.
    const classification = await i.call(i.jane.key, PATHS.classification(c.id))
    expect(classification.status).toBe(200)
    expect(classification.body.summary).toBe('The reported account broke the rules.')

    await claim(i, i.jane, c.id)
    const decided = await i.call(i.jane.key, PATHS.decision(c.id), {
      method: 'POST',
      body: { outcome: 'violation', category_id: 'scams_fraud.investment_scam', severity: c.triage.severity, action_keys: ['suspend_7d'], report_ids: [c.reportId] },
    })
    expect(decided.status, JSON.stringify(decided.body)).toBe(201)

    const [requested] = await webhooksOf(i, WEBHOOKS.actionRequested, (w) => w.data.case_id === c.id)
    expect(requested!.data).toMatchObject({ action_key: 'suspend_7d', subject_external_id: 'u_jack_doe', decision_id: decided.body.id })
    const requestId = requested!.data.action_request_id as string
    expect((await i.call(i.flaggingKey, PATHS.actionRequest(requestId))).body).toMatchObject({ status: 'pending' })

    expect((await i.call(i.flaggingKey, PATHS.confirmAction(requestId), { method: 'POST' })).status).toBe(200)
    await caseWhen(i, c.id, (x) => x.state === 'actioned', 'actioned')

    const types = (await i.facts()).filter((f) => f.key === c.id || f.data?.caseId === c.id).map((f) => f.type)
    for (const fact of [EVENTS.caseOpened, EVENTS.caseClassified, EVENTS.caseTriaged, EVENTS.caseClaimed, EVENTS.caseDecided, EVENTS.actionRequested, EVENTS.actionConfirmed]) {
      expect(types).toContain(fact)
    }
  })

  it('answers a failed action with another one that replaces it', async () => {
    const c = await triagedCase(i, { reported: 'u_jim_doe' })
    await claim(i, i.jane, c.id)
    const decided = await i.call(i.jane.key, PATHS.decision(c.id), {
      method: 'POST',
      body: { outcome: 'violation', category_id: 'scams_fraud.investment_scam', severity: c.triage.severity, action_keys: ['suspend_7d'], report_ids: [c.reportId] },
    })
    expect(decided.status, JSON.stringify(decided.body)).toBe(201)
    const [first] = await webhooksOf(i, WEBHOOKS.actionRequested, (w) => w.data.case_id === c.id)
    const firstId = first!.data.action_request_id as string

    // A retry before anything failed is refused.
    expect((await i.call(i.jane.key, PATHS.retryActions(c.id), { method: 'POST', body: { action_keys: ['ban'] } })).status).toBe(409)
    expect((await i.call(i.flaggingKey, PATHS.failAction(firstId), { method: 'POST', body: { reason: 'Account already deleted' } })).status).toBe(200)
    await caseWhen(i, c.id, (x) => x.state === 'action_failed', 'action_failed')

    const retried = await i.call(i.jane.key, PATHS.retryActions(c.id), { method: 'POST', body: { action_keys: ['ban'] } })
    expect(retried.status).toBe(200)
    expect(retried.body).toMatchObject({ state: 'decided' })

    const requests = await webhooksOf(i, WEBHOOKS.actionRequested, (w) => w.data.case_id === c.id, 2)
    const ban = requests.find((w) => w.data.action_key === 'ban')!
    expect((await i.call(i.flaggingKey, PATHS.actionRequest(firstId))).body).toMatchObject({ status: 'failed' })

    // The replaced request's failure no longer holds the case back once the new one is confirmed.
    expect((await i.call(i.flaggingKey, PATHS.confirmAction(ban.data.action_request_id), { method: 'POST' })).status).toBe(200)
    await caseWhen(i, c.id, (x) => x.state === 'actioned', 'actioned')
    expect((await i.facts()).some((f) => f.type === EVENTS.actionsRetried)).toBe(true)
  })
})
