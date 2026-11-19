// Scenarios 3 and 4: a P0 pre-rule hit makes a P0 case even when the app never calls the LLM, and
// reports on an account join its open case unless they belong in another severity band. Skipped
// without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall, type Install } from '../src/install.ts'
import { PATHS } from '../src/paths.ts'
import { caseOf, caseWhen, fileReport, triagedCase } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('P0 pre-rules and reports joining a case', () => {
  let i: Install

  beforeAll(async () => {
    i = await startInstall('p0-and-joining')
    expect((await i.call(i.jane.key, PATHS.llmSettings(), { method: 'PUT', body: { rules_only: true, fallback_to_rules: true } })).status).toBe(200)
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('makes a P0 case from a pre-rule hit without calling the LLM', async () => {
    const calls = i.net.llmCalls()
    const c = await triagedCase(i, { reported: 'u_jack_doe', category: 'harassment', text: 'i know where you live and you are dead' })
    expect(c).toMatchObject({ state: 'open', severity: 'P0', classified_by: 'rules' })
    expect(c.signals.length).toBeGreaterThan(0)
    expect(i.net.llmCalls()).toBe(calls)
  })

  it('attaches a report to the open case of its account, and opens a new one for another band', async () => {
    const first = await triagedCase(i, { reported: 'u_jim_doe' })
    expect(first.severity).not.toBe('P0')

    const second = await fileReport(i, { reported: 'u_jim_doe', reporter: 'u_john_doe' })
    expect(await caseOf(i, second)).toBe(first.id)
    await caseWhen(i, first.id, (c) => c.report_count === 2, 'two reports')

    const urgent = await fileReport(i, { reported: 'u_jim_doe', category: 'harassment', text: 'i know where you live' })
    const urgentCase = await caseOf(i, urgent)
    expect(urgentCase).not.toBe(first.id)
    expect(await caseWhen(i, urgentCase, (c) => c.state === 'open', 'open')).toMatchObject({ severity: 'P0', report_count: 1 })
  })
})
