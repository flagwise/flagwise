import { manualClock, type ManualClock, type TenantRef } from '@flagwise/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CaseRecord, CaseTriage, CaseWorkDeps, Decision, Severity } from '../src/app/ports.ts'
import { CaseWorkError, correctCase, decideCase, retryActions, type DecideInput } from '../src/app/work-case.ts'
import { InMemoryCaseRepository, RecordingPublisher } from './fakes.ts'

const tenant: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-03T09:00:00.000Z')
const OPENED = new Date('2026-11-02T00:00:00.000Z')
const HOUR = 3_600_000

const ALLOWED: Record<string, string[]> = {
  'scams_fraud.romance_scam': ['warn', 'suspend_7d', 'ban'],
  'spam.spam': ['warn', 'hide_content'],
  'child_safety.grooming': ['ban'],
}
const CATEGORY_SEVERITY: Record<string, Severity> = { 'scams_fraud.romance_scam': 'P1', 'spam.spam': 'P2', 'child_safety.grooming': 'P0' }

let repo: InMemoryCaseRepository
let publisher: RecordingPublisher
let clock: ManualClock
let deps: CaseWorkDeps

// A case's triage as triage gave it: the category's severity, P0 for a P0 category.
const fakeTriage = (categoryId: string): CaseTriage => {
  const s = CATEGORY_SEVERITY[categoryId]!
  const hours = { P0: 1, P1: 24, P2: 72 }[s]
  return { severity: s, priority: { P0: 3000, P1: 2000, P2: 1000 }[s], slaDueAt: new Date(OPENED.getTime() + hours * HOUR), suggestedActionKeys: [] }
}

beforeEach(() => {
  repo = new InMemoryCaseRepository()
  publisher = new RecordingPublisher()
  clock = manualClock(T0)
  deps = {
    cases: repo,
    events: publisher,
    clock,
    newCaseId: () => 'case_unused',
    newDecisionId: () => 'dec_1',
    catalog: { allowedActionKeys: async (_t, categoryId) => ALLOWED[categoryId] ?? null },
  }
})

const record = (o: Partial<CaseRecord> = {}): CaseRecord => ({
  id: 'case_1',
  tenant,
  subjectExternalId: 'u_jane_doe',
  band: 'standard',
  state: 'open',
  reportIds: ['rpt_1'],
  openedAt: OPENED,
  ...o,
})

const triaged = (categoryId = 'scams_fraud.romance_scam', o: Partial<CaseRecord> = {}) =>
  record({
    state: 'claimed',
    claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 },
    triage: fakeTriage(categoryId),
    classification: { categoryId, signals: [], injectionSuspected: false, classifiedBy: 'llm' },
    ...o,
  })

const decision = (o: Partial<Decision> = {}): Decision => ({
  id: 'dec_1',
  outcome: 'violation',
  categoryId: 'scams_fraud.romance_scam',
  severity: 'P1',
  actionKeys: ['suspend_7d'],
  decidedBy: 'mem_jane',
  decidedAt: T0,
  reportIds: ['rpt_1'],
  ...o,
})

const ref = (memberId = 'mem_jane') => ({ tenant, caseId: 'case_1', memberId })

async function rejectsWith(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => expect.unreachable('should have thrown'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CaseWorkError)
  expect(err).toMatchObject({ code })
}

describe('decision basis', () => {
  const decide = (o: Partial<DecideInput> = {}): DecideInput => ({
    ...ref(),
    outcome: 'violation',
    categoryId: 'scams_fraud.romance_scam',
    severity: 'P1',
    actionKeys: ['suspend_7d'],
    ...o,
  })

  it('records the reports shown to the moderator, in the case order', async () => {
    repo.seed(triaged(undefined, { reportIds: ['rpt_1', 'rpt_2', 'rpt_3'] }))
    const d = await decideCase(deps, decide({ reportIds: ['rpt_3', 'rpt_1'] }))
    expect(d.reportIds).toEqual(['rpt_1', 'rpt_3'])
    expect(publisher.events).toEqual([expect.objectContaining({ type: 'case.decided', reportIds: ['rpt_1', 'rpt_3'] })])
  })

  it("defaults to the case's reports when the decision is made", async () => {
    repo.seed(triaged(undefined, { reportIds: ['rpt_1', 'rpt_2'] }))
    expect((await decideCase(deps, decide())).reportIds).toEqual(['rpt_1', 'rpt_2'])
  })

  it("leaves out a report that joined after the moderator's read", async () => {
    repo.seed(triaged())
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.attachDirectly('case_1', 'rpt_2')
      }
    }
    const d = await decideCase(deps, decide())
    expect(d.reportIds).toEqual(['rpt_1'])
    expect(repo.get('case_1')?.reportIds).toEqual(['rpt_1', 'rpt_2'])
  })

  it.each([[[]], [['rpt_1', 'rpt_1']], [['rpt_9']]])('refuses the basis %j', async (reportIds) => {
    repo.seed(triaged())
    await rejectsWith(decideCase(deps, decide({ reportIds })), 'invalid_basis')
    expect(publisher.events).toEqual([])
  })
})

describe('correctCase', () => {
  it('changes the category and its severity, and publishes before and after for triage to triage it again', async () => {
    repo.seed(triaged())
    clock.advance(60_000)
    const now = new Date(T0.getTime() + 60_000)
    const saved = await correctCase(deps, { ...ref(), categoryId: 'spam.spam' })
    expect(saved).toMatchObject({
      state: 'claimed',
      claim: { memberId: 'mem_jane', lastActivityAt: now },
      // Priority and SLA stay until triage answers.
      triage: { severity: 'P2', priority: 2000, slaDueAt: new Date(OPENED.getTime() + 24 * HOUR) },
      classification: { categoryId: 'spam.spam', classifiedBy: 'llm' },
    })
    expect(repo.get('case_1')).toEqual(saved)
    expect(publisher.events).toEqual([
      {
        type: 'case.corrected',
        tenant,
        caseId: 'case_1',
        before: { categoryId: 'scams_fraud.romance_scam', severity: 'P1' },
        after: { categoryId: 'spam.spam', severity: null },
        correctedBy: 'mem_jane',
        occurredAt: now,
      },
    ])
  })

  it('raises the severity, and a P2 case to P0', async () => {
    repo.seed(triaged('spam.spam'))
    expect((await correctCase(deps, { ...ref(), severity: 'P1' })).triage?.severity).toBe('P1')
    expect((await correctCase(deps, { ...ref(), severity: 'P0' })).triage?.severity).toBe('P0')
  })

  it('never lowers a P0 case', async () => {
    repo.seed(triaged('child_safety.grooming'))
    await rejectsWith(correctCase(deps, { ...ref(), severity: 'P2' }), 'invalid_correction')
    await rejectsWith(correctCase(deps, { ...ref(), categoryId: 'spam.spam' }), 'invalid_correction')
    expect(repo.get('case_1')?.triage?.severity).toBe('P0')
    expect(publisher.events).toEqual([])
  })

  it('refuses a severity P0 rules override, and an unknown category', async () => {
    repo.seed(triaged('spam.spam'))
    await rejectsWith(correctCase(deps, { ...ref(), categoryId: 'child_safety.grooming', severity: 'P2' }), 'invalid_correction')
    await rejectsWith(correctCase(deps, { ...ref(), categoryId: 'made_up' }), 'invalid_correction')
  })

  it('makes a case with a P0 signal or the pre-rules P0 P0 in any category', async () => {
    repo.seed(triaged('spam.spam', { classification: { categoryId: 'spam.spam', signals: ['minor_involved'], injectionSuspected: false, classifiedBy: 'llm' } }))
    await rejectsWith(correctCase(deps, { ...ref(), severity: 'P1' }), 'invalid_correction')
    expect((await correctCase(deps, { ...ref(), categoryId: 'scams_fraud.romance_scam' })).triage?.severity).toBe('P0')
    repo.seed(triaged('spam.spam', { band: 'p0' }))
    await rejectsWith(correctCase(deps, { ...ref(), categoryId: 'scams_fraud.romance_scam', severity: 'P1' }), 'invalid_correction')
  })

  it('writes nothing when nothing changes', async () => {
    repo.seed(triaged())
    await correctCase(deps, { ...ref(), categoryId: 'scams_fraud.romance_scam', severity: 'P1' })
    expect(repo.calls.filter((c) => c.method === 'change')).toHaveLength(0)
    expect(publisher.events).toEqual([])
  })

  it("needs the caller's own claim on a triaged case", async () => {
    await rejectsWith(correctCase(deps, { ...ref(), severity: 'P1' }), 'not_found')
    repo.seed(record({ state: 'open', triage: fakeTriage('scams_fraud.romance_scam') }))
    await rejectsWith(correctCase(deps, { ...ref(), severity: 'P1' }), 'not_claimed')
    repo.seed(triaged())
    await rejectsWith(correctCase(deps, { ...ref('mem_john'), severity: 'P2' }), 'claimed_by_other')
    repo.seed(record({ state: 'claimed', claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 } }))
    await rejectsWith(correctCase(deps, { ...ref(), severity: 'P1' }), 'invalid_state')
  })
})

describe('correctCase on an untriaged or custom-category case', () => {
  const untriaged = () =>
    record({
      state: 'claimed',
      claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 },
      classification: { categoryId: 'scams_fraud.romance_scam', signals: [], injectionSuspected: false, classifiedBy: 'rules' },
    })

  it('asks triage to triage a case claimed from untriaged, even with no change', async () => {
    repo.seed(untriaged())
    const saved = await correctCase(deps, { ...ref(), categoryId: 'scams_fraud.romance_scam' })
    expect(saved.triage).toBeUndefined()
    expect(publisher.events).toEqual([
      expect.objectContaining({ type: 'case.corrected', before: { categoryId: 'scams_fraud.romance_scam', severity: null }, after: { categoryId: 'scams_fraud.romance_scam', severity: null } }),
    ])
  })

  it('keeps the custom category with the category, and drops it with a new one', async () => {
    repo.seed(triaged(undefined, { classification: { categoryId: 'scams_fraud.romance_scam', customCategoryId: 'asking_for_money', signals: [], injectionSuspected: false, classifiedBy: 'rules' } }))
    expect((await correctCase(deps, { ...ref(), severity: 'P0' })).classification?.customCategoryId).toBe('asking_for_money')
    const moved = await correctCase(deps, { ...ref(), categoryId: 'child_safety.grooming' })
    expect(moved.classification).toEqual({ categoryId: 'child_safety.grooming', signals: [], injectionSuspected: false, classifiedBy: 'rules' })
  })
})

describe('retryActions', () => {
  const failed = (o: Partial<CaseRecord> = {}) => record({ state: 'action_failed', decision: decision(), ...o })

  it('moves the case back to decided and publishes the retry, naming the failures it answers', async () => {
    repo.seed(failed())
    await repo.addActionFailure(tenant, 'case_1', 'acr_1')
    await repo.addActionFailure(tenant, 'case_1', 'acr_2')
    await repo.answerActionFailures(tenant, 'case_1', ['acr_1'])
    const saved = await retryActions(deps, { ...ref('key_admin'), actionKeys: ['warn'] })
    expect(saved.state).toBe('decided')
    expect(repo.get('case_1')?.state).toBe('decided')
    expect(publisher.events).toEqual([
      {
        type: 'case.actions_retried',
        tenant,
        caseId: 'case_1',
        decisionId: 'dec_1',
        subjectExternalId: 'u_jane_doe',
        categoryId: 'scams_fraud.romance_scam',
        severity: 'P1',
        actionKeys: ['warn'],
        replaces: ['acr_2'],
        retriedBy: 'key_admin',
        occurredAt: T0,
      },
    ])
    expect(await repo.openActionFailures(tenant, 'case_1')).toEqual([])
  })

  it('accepts an empty list', async () => {
    repo.seed(failed())
    expect((await retryActions(deps, { ...ref(), actionKeys: [] })).state).toBe('decided')
  })

  it('refuses keys the category does not allow, or listed twice', async () => {
    repo.seed(failed())
    await rejectsWith(retryActions(deps, { ...ref(), actionKeys: ['hide_content'] }), 'invalid_decision')
    await rejectsWith(retryActions(deps, { ...ref(), actionKeys: ['warn', 'warn'] }), 'invalid_decision')
    expect(repo.get('case_1')?.state).toBe('action_failed')
  })

  it('needs a case in action_failed', async () => {
    await rejectsWith(retryActions(deps, { ...ref(), actionKeys: [] }), 'not_found')
    repo.seed(failed({ state: 'decided' }))
    await rejectsWith(retryActions(deps, { ...ref(), actionKeys: [] }), 'invalid_state')
    expect(publisher.events).toEqual([])
  })
})
