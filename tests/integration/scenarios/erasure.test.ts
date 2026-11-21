// Scenario 8: erasing an account everywhere: every service that got the request answers, the
// erasure completes with each service's answer, the account's evidence is gone, its case keeps its
// facts under a tombstone, and the tenant gets subject.erased. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, startInstall, type Install } from '../src/install.ts'
import { PATHS, WEBHOOKS } from '../src/paths.ts'
import { triagedCase, webhooksOf } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('erasure', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall()
    i.net.llm = () => ({ category_id: 'scams_fraud.investment_scam' })
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('erases a subject in every service that holds its data and reports each one as done', async () => {
    const c = await triagedCase(i, { reported: 'u_john_doe' })
    expect((await i.call(i.jane.key, PATHS.evidence(c.reportId))).status).toBe(200)

    const started = await i.call(i.jane.key, PATHS.erase('u_john_doe'), { method: 'POST' })
    expect(started.status).toBe(202)
    expect(started.body).toMatchObject({ object: 'erasure', subject_external_id: 'u_john_doe', completed_at: null })
    // Asked again while it runs: the same erasure.
    const again = await i.call(i.jane.key, PATHS.erase('u_john_doe'), { method: 'POST' })
    expect(again.body.id).toBe(started.body.id)

    const done = await eventually(async () => {
      const res = await i.call(i.jane.key, PATHS.erasure(started.body.id))
      return res.status === 200 && res.body.status === 'completed' ? res.body : undefined
    }, 'the erasure to complete')
    // Every group the request reached answered; the ones that hold the account's data erased it.
    const answers = Object.fromEntries(done.groups.map((g: { group: string; status: string }) => [g.group, g.status]))
    expect(answers).toMatchObject({ 'intake.erasure': 'erased', 'classify.erasure': 'erased', 'triage.erasure': 'erased', 'cases.erasure': 'erased', 'audit.erasure': 'erased', 'policy.erasure': 'nothing_held' })
    expect(done.groups.every((g: { status: string }) => ['erased', 'nothing_held'].includes(g.status))).toBe(true)
    // It reached every service that holds data, each once.
    expect(Object.keys(answers).sort()).toEqual(['apps.erasure', 'audit.erasure', 'auth.erasure', 'cases.erasure', 'classify.erasure', 'delivery.erasure', 'intake.erasure', 'notifications.erasure', 'policy.erasure', 'triage.erasure'])
    expect(done.groups).toHaveLength(Object.keys(answers).length)

    expect((await i.call(i.jane.key, PATHS.evidence(c.reportId))).status).toBe(410)
    const kept = (await i.call(i.jane.key, PATHS.case(c.id))).body
    expect(kept).toMatchObject({ id: c.id, category_id: c.category_id, triage: { severity: c.triage.severity } })
    expect(kept.subject_external_id).not.toBe('u_john_doe')
    const [hook] = await webhooksOf(i, WEBHOOKS.subjectErased)
    expect(hook!.data).toMatchObject({ erasure_id: started.body.id, subject_external_id: 'u_john_doe', held_items: 0 })
  })

  // A service that is down, in a topology where it runs on its own, is pending until it answers
  // (the privacy unit tests cover it with a group that fails); this suite runs one process, so it
  // waits for choosing the services a process runs (phase 2).
  it.todo('reports a service that is down as pending, not as done')
})
