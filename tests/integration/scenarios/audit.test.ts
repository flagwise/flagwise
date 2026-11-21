// The audit log as an admin reads it: a case's whole story, each step with who caused it (a
// moderator's key, the tenant's backend, the system, the operator's CLI), config changes with the
// list before and after, the hash chain verifying, and each mode its own log. Skipped without
// TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { createKey } from '@flagwise/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { PATHS, WEBHOOKS } from '../src/paths.ts'
import { caseWhen, claim, setActionKeys, triagedCase, webhooksOf } from '../src/steps.ts'

type Entry = { action: string; actor: { type: string; id: string }; target: { type: string; id: string }; facts: Record<string, any> }

describe.skipIf(!testDatabaseUrl)('the audit log', () => {
  let i: Install
  const entries = async (query: string, until: (data: Entry[]) => boolean, what: string) =>
    eventually(async () => {
      const page = (await i.call(i.jane.key, PATHS.auditEntries(query))).body
      return page?.data && until(page.data) ? (page.data as Entry[]) : undefined
    }, what)

  beforeAll(async () => {
    i = await startInstall()
    i.net.llm = () => ({ category_id: 'scams_fraud.romance_scam' })
    await setActionKeys(i)
  })
  afterAll(async () => {
    await i?.stop()
  })

  it("tells a case's story, each step with its actor", async () => {
    const c = await triagedCase(i, { reported: 'u_jack_doe' })
    await claim(i, i.jane, c.id)
    const decided = await i.call(i.jane.key, PATHS.decision(c.id), {
      method: 'POST',
      body: { outcome: 'violation', category_id: 'scams_fraud.romance_scam', severity: c.triage.severity, action_keys: ['suspend_7d'], report_ids: [c.reportId] },
    })
    expect(decided.status).toBe(201)
    const [first] = await webhooksOf(i, WEBHOOKS.actionRequested, (w) => w.data.case_id === c.id)
    const firstId = first!.data.action_request_id as string
    await i.call(i.flaggingKey, PATHS.failAction(firstId), { method: 'POST', body: { reason: 'Account already deleted' } })
    await caseWhen(i, c.id, (x) => x.state === 'action_failed', 'action_failed')
    await i.call(i.jane.key, PATHS.retryActions(c.id), { method: 'POST', body: { action_keys: ['ban'] } })
    const ban = (await webhooksOf(i, WEBHOOKS.actionRequested, (w) => w.data.case_id === c.id && w.data.action_key === 'ban'))[0]!
    await i.call(i.flaggingKey, PATHS.confirmAction(ban.data.action_request_id), { method: 'POST' })

    const story = await entries(`case_id=${c.id}`, (d) => d.some((e) => e.action === 'decision.actions_confirmed'), "the case's story")
    const actions = new Set(story.map((e) => e.action))
    for (const action of ['case.opened', 'case.classified', 'case.triaged', 'case.claimed', 'case.decided', 'action.requested', 'action.failed', 'case.actions_retried', 'action.confirmed', 'decision.actions_confirmed']) {
      expect(actions, action).toContain(action)
    }
    const entry = (action: string) => story.find((e) => e.action === action)!
    expect(entry('case.decided')).toMatchObject({
      actor: { type: 'api_key', id: i.jane.id },
      target: { type: 'case', id: c.id },
      facts: { action_keys: ['suspend_7d'], report_ids: [c.reportId], decided_by: i.jane.id, request_id: expect.stringMatching(/^req_/) },
    })
    expect(entry('case.triaged')).toMatchObject({ actor: { type: 'system', id: 'system' } })
    expect(entry('case.actions_retried')).toMatchObject({ facts: { action_keys: ['ban'], retried_by: i.jane.id } })
    expect(story.filter((e) => e.action === 'action.requested').at(-1)).toMatchObject({ facts: { action_key: 'ban', replaces: [firstId] } })
    // The tenant's backend answered, with its own key.
    expect(entry('action.confirmed')).toMatchObject({ actor: { type: 'api_key' }, target: { type: 'action_request', id: ban.data.action_request_id } })
    expect(entry('action.confirmed').actor.id).not.toBe(i.jane.id)
  })

  it('records config changes with the list before and after, and the keys the operator issued', async () => {
    await setActionKeys(i, [{ key: 'warn', label: { en: 'Warn' }, categories: ['*'] }])
    const changes = (await entries(`actor_id=${i.jane.id}`, (d) => d.filter((e) => e.action === 'config.action_keys_replaced').length === 2, 'two action key changes')).filter(
      (e) => e.action === 'config.action_keys_replaced',
    )
    const keysOf = (list: { key: string }[]) => list.map((k) => k.key)
    expect(keysOf(changes.find((e) => keysOf(e.facts.after).length === 1)!.facts.after)).toEqual(['warn'])
    expect(changes.some((e) => e.facts.before.length === 0)).toBe(true)

    // The CLI issued the admin keys, as the operator; the key itself is never in the log.
    const issued = (await i.call(i.jane.key, PATHS.auditEntries('actor_id=cli'))).body.data as Entry[]
    expect(issued).toContainEqual(expect.objectContaining({ action: 'api_key.issued', actor: { type: 'operator', id: 'cli' }, target: { type: 'api_key', id: i.jane.id }, facts: { scopes: ['admin'] } }))
    expect(JSON.stringify(issued)).not.toContain(i.jane.key.slice(8))
  })

  it('verifies its chain, for admin keys only, and keeps each mode apart', async () => {
    expect((await i.call(i.jane.key, PATHS.auditVerify())).body).toMatchObject({ object: 'audit_verification', ok: true })
    expect((await i.call(i.jane.key, PATHS.auditEntries('limit=0'))).status).toBe(422)
    expect((await i.call(i.flaggingKey, PATHS.auditEntries())).status).toBe(403)
    const testAdmin = await createKey(i.config, { ...i.appRef, livemode: false, scopes: ['admin'] })
    expect((await i.call(testAdmin.key, PATHS.auditEntries(`actor_id=${i.jane.id}`))).body.data).toEqual([])
  })
})
