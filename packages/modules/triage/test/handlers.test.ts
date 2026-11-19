// Triage on an in-memory bus: its record of each case from the cases' events, and when it triages.
import { DEFAULT_POLICY, eventContract, type Policy } from '@flagwise/contracts'
import type { AppRef } from '@flagwise/kernel'
import { createMemoryBus, memoryDocumentCopy, memoryUnitOfWork, type MemoryBus } from '@flagwise/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { erasedFromCase, subscribeTriage, type TriageCase, type TriageCaseStore } from '../src/index.ts'

const appRef: AppRef = { appId: 'app_a', livemode: true }
const T0 = '2026-11-19T09:00:00.000Z'
const H = 3_600_000

class Cases implements TriageCaseStore {
  readonly rows = new Map<string, TriageCase>()
  async find(_t: AppRef, id: string) {
    return this.rows.get(id) ?? null
  }
  async open(r: TriageCase) {
    if (!this.rows.has(r.caseId)) this.rows.set(r.caseId, r)
  }
  async attach(_t: AppRef, id: string, reportId: string, facts: Parameters<TriageCaseStore['attach']>[3]) {
    const r = this.rows.get(id)
    if (!r) return false
    if (!r.reportIds.includes(reportId)) this.rows.set(id, { ...r, reportIds: [...r.reportIds, reportId], reports: facts ? [...r.reports, { reportId, ...facts }] : r.reports })
    return true
  }
  async change(_t: AppRef, id: string, change: Parameters<TriageCaseStore['change']>[2]) {
    const r = this.rows.get(id)
    if (r) this.rows.set(id, { ...r, ...change })
    return !!r
  }  async eraseAccount(_t: AppRef, externalId: string, erasedId: string) {
    let n = 0
    for (const [id, r] of this.rows) {
      const erased = erasedFromCase(r, externalId, erasedId)
      if (erased) (this.rows.set(id, erased), n++)
    }
    return n
  }
}

let bus: MemoryBus
let cases: Cases
let policy: ReturnType<typeof memoryDocumentCopy<Policy>>
let n: number

beforeEach(() => {
  bus = createMemoryBus({ contract: eventContract })
  cases = new Cases()
  policy = memoryDocumentCopy<Policy>()
  n = 0
  subscribeTriage(bus, { uow: memoryUnitOfWork(bus, { cases }), policy })
})

const publish = (type: string, data: Record<string, unknown>, id = `${type}:${++n}`) => bus.publish({ id, type, key: String(data['caseId']), data, appRef })
const classification = (over: Record<string, unknown> = {}) => ({
  caseId: 'case_1',
  reportId: 'rpt_1',
  categoryId: 'scams_fraud.romance_scam',
  customCategoryId: null,
  signals: [],
  injectionSuspected: false,
  preRuleP0: false,
  classifiedBy: 'llm',
  rulesReason: null,
  ...over,
})
const open = async () => {
  await publish('case.opened.v1', {
    caseId: 'case_1',
    reportId: 'rpt_1',
    subjectExternalId: 'u_john_doe',
    band: 'standard',
    facts: { reporterExternalId: 'u_jane_doe', reporterAccountCreatedAt: null, reportedAccountCreatedAt: new Date(Date.parse(T0) - 2 * 24 * H).toISOString() },
    occurredAt: T0,
  })
  await publish('case.report_attached.v1', { caseId: 'case_1', reportId: 'rpt_2', occurredAt: T0 })
}
const triaged = () => bus.log().filter((l) => l.event.type === 'case.triaged.v1').map((l) => l.event)
const types = () => bus.log().map((l) => l.event.type)

describe('triage on the bus', () => {
  it("triages a classified case with its opened time, its reports and their accounts' facts", async () => {
    await open()
    await publish('case.classified.v1', classification())
    await bus.drain()
    expect(triaged()).toEqual([
      expect.objectContaining({
        id: 'case.triaged:case_1',
        key: 'case_1',
        data: expect.objectContaining({ caseId: 'case_1', reportIds: ['rpt_1', 'rpt_2'], severity: 'P1', slaDueAt: new Date(Date.parse(T0) + 24 * H).toISOString(), applied: ['reported_new_account'] }),
      }),
    ])
    expect(cases.rows.get('case_1')?.state).toBe('triaged')
    // A classification delivered again changes nothing.
    await publish('case.classified.v1', classification())
    await bus.drain()
    expect(triaged()).toHaveLength(1)
  })

  it("publishes case.untriaged when the LLM failed and the app's policy does not fall back to rules", async () => {
    await policy.keep(appRef, 1, { ...DEFAULT_POLICY, llm: { rulesOnly: false, fallbackToRules: false } })
    await open()
    await publish('case.classified.v1', classification({ classifiedBy: 'rules', rulesReason: 'llm_failed' }))
    await bus.drain()
    expect(types()).toContain('case.untriaged.v1')
    expect(triaged()).toEqual([])
    // Once the LLM answers, the untriaged case is triaged.
    await publish('case.reclassified.v1', classification())
    await bus.drain()
    expect(triaged().map((e) => e.id)).toEqual(['case.triaged:case_1:llm_retry'])
  })

  it('triages again after the LLM answers only while no moderator holds, corrected or decided the case', async () => {
    const rules = classification({ classifiedBy: 'rules', rulesReason: 'llm_failed', categoryId: 'other' })
    await open()
    await publish('case.classified.v1', rules)
    await publish('case.claimed.v1', { caseId: 'case_1', memberId: 'mem_jane', occurredAt: T0 })
    await publish('case.reclassified.v1', classification())
    await bus.drain()
    expect(triaged().map((e) => e.id)).toEqual(['case.triaged:case_1'])

    // Released untouched: the next answer triages it again.
    await publish('case.released.v1', { caseId: 'case_1', memberId: 'mem_jane', reason: 'released', occurredAt: T0 })
    await publish('case.reclassified.v1', classification(), 'case.reclassified:again')
    await bus.drain()
    expect(triaged().map((e) => e.id)).toEqual(['case.triaged:case_1', 'case.triaged:case_1:llm_retry'])
  })

  it('leaves a corrected case alone, and an untriaged one a moderator has claimed', async () => {
    await policy.keep(appRef, 1, { ...DEFAULT_POLICY, llm: { rulesOnly: false, fallbackToRules: false } })
    await open()
    await publish('case.classified.v1', classification({ classifiedBy: 'rules', rulesReason: 'llm_failed' }))
    await publish('case.claimed.v1', { caseId: 'case_1', memberId: 'mem_jane', occurredAt: T0 })
    await publish('case.released.v1', { caseId: 'case_1', memberId: 'mem_jane', reason: 'released', occurredAt: T0 })
    await publish('case.reclassified.v1', classification())
    await bus.drain()
    expect(triaged()).toEqual([])
    expect(cases.rows.get('case_1')).toMatchObject({ state: 'untriaged', claimed: false, everClaimed: true })

    await publish('case.corrected.v1', {
      caseId: 'case_1',
      before: { categoryId: 'other', severity: null },
      after: { categoryId: 'other', severity: 'P2', priority: 1000, slaDueAt: T0 },
      correctedBy: 'mem_jane',
      occurredAt: T0,
    })
    await bus.drain()
    expect(cases.rows.get('case_1')?.corrected).toBe(true)
  })

  it("triages a corrected case again on the moderator's category and severity, and the next correction on the last", async () => {
    await open()
    await publish('case.classified.v1', classification({ customCategoryId: 'asking_for_money' }))
    await publish('case.claimed.v1', { caseId: 'case_1', memberId: 'mem_jane', occurredAt: T0 })
    const correct = (after: Record<string, unknown>, id: string) =>
      publish('case.corrected.v2', { caseId: 'case_1', before: { categoryId: 'scams_fraud.romance_scam', severity: 'P1' }, after, correctedBy: 'mem_jane', occurredAt: T0 }, id)
    await correct({ categoryId: 'scams_fraud.romance_scam', severity: 'P0' }, 'case.corrected:case_1:evt_1')
    await bus.drain()
    expect(triaged().at(-1)).toMatchObject({
      id: 'case.triaged:case.corrected:case_1:evt_1',
      data: { categoryId: 'scams_fraud.romance_scam', customCategoryId: 'asking_for_money', severity: 'P0', slaDueAt: new Date(Date.parse(T0) + H).toISOString(), cause: 'correction' },
    })

    // A new category drops the app's one; without a severity the category's own counts.
    await correct({ categoryId: 'spam.spam', severity: null }, 'case.corrected:case_1:evt_2')
    await bus.drain()
    expect(triaged().at(-1)).toMatchObject({ data: { categoryId: 'spam.spam', customCategoryId: null, severity: 'P2', cause: 'correction' } })
    expect(cases.rows.get('case_1')).toMatchObject({ corrected: true, classification: { categoryId: 'spam.spam', customCategoryId: null } })
    expect(triaged().map((e) => (e.data as { cause: string }).cause)).toEqual(['classification', 'correction', 'correction'])
  })

  it('triages an untriaged case a moderator triages by hand', async () => {
    await policy.keep(appRef, 1, { ...DEFAULT_POLICY, llm: { rulesOnly: false, fallbackToRules: false } })
    await open()
    await publish('case.classified.v1', classification({ classifiedBy: 'rules', rulesReason: 'llm_failed', signals: ['minor_involved'] }))
    await publish('case.claimed.v1', { caseId: 'case_1', memberId: 'mem_jane', occurredAt: T0 })
    await publish('case.corrected.v2', {
      caseId: 'case_1',
      before: { categoryId: 'scams_fraud.romance_scam', severity: null },
      after: { categoryId: 'scams_fraud.romance_scam', severity: null },
      correctedBy: 'mem_jane',
      occurredAt: T0,
    })
    await bus.drain()
    expect(triaged()).toEqual([expect.objectContaining({ data: expect.objectContaining({ severity: 'P0', classifiedBy: 'rules', cause: 'correction' }) })])
    expect(cases.rows.get('case_1')?.state).toBe('triaged')
  })

  it('dead-letters a classification of a case it has no record of', async () => {
    await publish('case.classified.v1', classification({ caseId: 'case_unknown' }))
    await bus.drain()
    expect(bus.deadLetters()).toEqual([expect.objectContaining({ group: 'triage' })])
  })
})
