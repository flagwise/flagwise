// Classify on an in-memory bus, alone: flagging's and moderation's facts (a report received with its
// pre-rule screening, a case opened) in, case.classified out, once per case and without the summary.
import { DEFAULT_POLICY, eventContract, type EventData, type Policy } from '@flagwise/contracts'
import { manualClock } from '@flagwise/kernel'
import { createMemoryBus, memoryDocumentCopy, memoryStorage, type MemoryBus } from '@flagwise/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { classifyDepsWithPolicy, subscribeClassify } from '../src/index.ts'
import { A, answer, MemoryStore, PROMPT, ScriptedProvider, snapshotBytes } from './fakes.ts'

let bus: MemoryBus
let store: MemoryStore
let llm: ScriptedProvider
let seq: number

beforeEach(async () => {
  bus = createMemoryBus({ contract: eventContract })
  store = new MemoryStore()
  llm = new ScriptedProvider([answer(), answer({ category_id: 'child_safety.underage_user', signals: [] })])
  seq = 0
  const storage = memoryStorage()
  for (const id of ['rpt_1', 'rpt_2']) await storage.put(`apps/app_a/${id}`, snapshotBytes('He wants money, mail me at john.doe@example.com'), 'application/json')
  const policy = memoryDocumentCopy<Policy>()
  await policy.keep(A, 1, DEFAULT_POLICY)
  const classify = classifyDepsWithPolicy({ run: (_appRef, fn) => fn(store), snapshots: storage, clock: manualClock('2026-11-21T09:00:00Z'), llm: { provider: llm, model: 'small', escalationModel: 'strong', prompt: PROMPT }, redact: true }, policy)
  subscribeClassify(bus, { classify, policy })
})

async function fact(type: Parameters<typeof eventContract.versionOf>[0], key: string, data: unknown, id = `${type}:${key}:${++seq}`) {
  await bus.publish({ id, type, key, data, appRef: A })
  await bus.drain()
}
const opened = (caseId: string, reportId: string) =>
  fact('case.opened.v1', caseId, { caseId, reportId, subjectExternalId: 'u_john_doe', band: 'standard', occurredAt: '2026-11-21T09:00:00.000Z' } satisfies EventData<'case.opened.v1'>, `case.opened:${caseId}`)
const classified = () => bus.log().filter((l) => l.event.type === 'case.classified.v1').map((l) => l.event.data as EventData<'case.classified.v1'>)

describe('classify on the bus', () => {
  it('classifies a case once on its opening, with the facts triage needs and never the summary', async () => {
    await opened('case_1', 'rpt_1')
    expect(classified()).toEqual([expect.objectContaining({ caseId: 'case_1', reportId: 'rpt_1', categoryId: 'scams_fraud.romance_scam', classifiedBy: 'llm', preRuleP0: false })])
    expect(JSON.stringify(classified())).not.toContain('The reported account asked for $200.')
    expect(store.rows[0]).toMatchObject({ caseId: 'case_1', summary: 'The reported account asked for $200.' })
    // The evidence reached the LLM redacted.
    expect(llm.requests[0]!.input).toContain('[EMAIL]')
    expect(llm.requests[0]!.input).not.toContain('john.doe@example.com')

    // Delivered again, it calls the LLM no more.
    bus.replay('classify')
    await bus.drain()
    expect(llm.requests).toHaveLength(1)
    expect(classified()).toHaveLength(1)
    expect(bus.deadLetters()).toEqual([])
  })

  it("takes a report's pre-rule screening from report.received and keeps its P0 the LLM missed", async () => {
    await fact('report.received.v1', 'rpt_2', {
      reportId: 'rpt_2',
      subjectExternalId: 'u_john_doe',
      p0Signal: true,
      p0Signals: ['minor_involved'],
      injectionSuspected: false,
      facts: { reporterExternalId: 'u_jane_doe', reporterAccountCreatedAt: null, reportedAccountCreatedAt: null },
      evidenceRef: 'apps/app_a/rpt_2',
    } satisfies EventData<'report.received.v1'>)
    await opened('case_2', 'rpt_2')
    expect(classified()).toEqual([expect.objectContaining({ caseId: 'case_2', signals: ['minor_involved'], preRuleP0: true })])
    // The P0 signal escalated the case to the stronger model.
    expect(llm.requests.at(-1)!.model).toBe('strong')
  })
})
