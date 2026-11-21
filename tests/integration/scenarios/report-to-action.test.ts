// Scenarios 1 and 6: a report becomes an LLM-classified, triaged case; a moderator claims and
// decides it; the tenant receives and confirms the action; a failed action is answered with
// another, which replaces it. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall, type Install } from '../src/install.ts'
import { EVENTS, PATHS, WEBHOOKS } from '../src/paths.ts'
import { signedWith } from '../src/signature.ts'
import { caseWhen, claim, fileReport, setActionKeys, triagedCase, webhooksOf } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('from report to action', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall()
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
    expect(signedWith(i.webhookSecret, triaged!)).toBe(true)

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
    expect(requested!.data).toMatchObject({ action_key: 'suspend_7d', subject_external_id: 'u_jack_doe', decision_id: decided.body.id, reason: 'decision' })
    expect(signedWith(i.webhookSecret, requested!)).toBe(true)
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

    // Only keys the category allows, each once.
    expect((await i.call(i.jane.key, PATHS.retryActions(c.id), { method: 'POST', body: { action_keys: ['ban', 'ban'] } })).status).toBe(422)
    expect((await i.call(i.jane.key, PATHS.retryActions(c.id), { method: 'POST', body: {} })).status).toBe(422)
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

  it('decides only on the reports shown, once per Idempotency-Key', async () => {
    const c = await triagedCase(i, { reported: 'u_joe_doe' })
    await claim(i, i.jane, c.id)
    // A report joining while the case is claimed is not part of a decision made on the first one.
    const second = await fileReport(i, { reported: 'u_joe_doe' })
    await caseWhen(i, c.id, (x) => x.report_count === 2, 'two reports')

    const decision = { outcome: 'violation', category_id: 'scams_fraud.investment_scam', severity: c.triage.severity, action_keys: ['warn'], report_ids: [c.reportId] }
    const decide = (body: unknown, key?: string) => i.call(i.jane.key, PATHS.decision(c.id), { method: 'POST', body, ...(key !== undefined && { headers: { 'idempotency-key': key } }) })
    expect((await decide({ ...decision, report_ids: ['rpt_unknown'] })).status).toBe(422)
    expect((await decide(decision, 'bad key')).status).toBe(400)
    const made = await decide(decision, 'decide-1')
    expect(made.status).toBe(201)
    expect(made.body).toMatchObject({ report_ids: [c.reportId], action_keys: ['warn'] })

    // A retry with the same key gets the first answer; the key with another request is refused.
    const replay = await decide(decision, 'decide-1')
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(replay.body).toEqual(made.body)
    expect((await decide({ ...decision, report_ids: [c.reportId, second] }, 'decide-1')).status).toBe(409)
    // Without the key, a second decision is refused as usual.
    expect((await decide(decision)).status).toBe(409)
  })

  it("takes each action request's answer once, from an actions key only, and lets a decision drop a failed one", async () => {
    const c = await triagedCase(i, { reported: 'u_jeff_doe' })
    await claim(i, i.jane, c.id)
    const decided = await i.call(i.jane.key, PATHS.decision(c.id), {
      method: 'POST',
      body: { outcome: 'violation', category_id: 'scams_fraud.investment_scam', severity: c.triage.severity, action_keys: ['warn', 'ban'], report_ids: [c.reportId] },
    })
    expect(decided.status).toBe(201)
    const requests = await webhooksOf(i, WEBHOOKS.actionRequested, (w) => w.data.case_id === c.id, 2)
    const warn = requests.find((w) => w.data.action_key === 'warn')!.data.action_request_id as string
    const ban = requests.find((w) => w.data.action_key === 'ban')!.data.action_request_id as string

    // Answers come from the tenant's backend, not from a moderator's key.
    expect((await i.call(i.jane.key, PATHS.actionRequest(warn))).status).toBe(403)
    expect((await i.call(i.flaggingKey, PATHS.actionRequest(warn))).body).toEqual({ object: 'action_request', id: warn, status: 'pending', action_key: 'warn', case_id: c.id, decision_id: decided.body.id, fail_reason: null })
    expect((await i.call(i.flaggingKey, PATHS.failAction(ban), { method: 'POST', body: {} })).status).toBe(422)
    expect((await i.call(i.flaggingKey, PATHS.failAction(ban), { method: 'POST', body: { reason: 'Not supported' } })).body).toMatchObject({ status: 'failed', fail_reason: 'Not supported' })
    await caseWhen(i, c.id, (x) => x.state === 'action_failed', 'action_failed')
    // An empty retry accepts the failure; the case is actioned once the rest is confirmed.
    expect((await i.call(i.jane.key, PATHS.retryActions(c.id), { method: 'POST', body: { action_keys: [] } })).body).toMatchObject({ state: 'decided' })
    expect((await i.call(i.flaggingKey, PATHS.confirmAction(warn), { method: 'POST' })).status).toBe(200)
    await caseWhen(i, c.id, (x) => x.state === 'actioned', 'actioned')

    // The same answer again is harmless; the other answer is a conflict.
    expect((await i.call(i.flaggingKey, PATHS.confirmAction(warn), { method: 'POST' })).status).toBe(200)
    expect((await i.call(i.flaggingKey, PATHS.failAction(warn), { method: 'POST', body: { reason: 'User not found' } })).status).toBe(409)
    expect((await i.call(i.flaggingKey, PATHS.actionRequest('acr_none'))).status).toBe(404)
    expect((await i.call(i.flaggingKey, PATHS.confirmAction('acr_none'), { method: 'POST' })).status).toBe(404)
  })
})
