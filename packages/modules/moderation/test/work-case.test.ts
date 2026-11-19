import { manualClock, type ManualClock, type AppRef } from '@flagwise/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { CaseChangedError, type CaseRecord, type CaseWorkDeps, type Decision } from '../src/app/ports.ts'
import { CLAIM_IDLE_MS, CaseWorkError, claimCase, decideCase, releaseCase, type DecideInput } from '../src/app/work-case.ts'
import type { CaseState } from '../src/domain/case-state.ts'
import { InMemoryCaseRepository, RecordingPublisher } from './fakes.ts'

const appRef: AppRef = { appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-03T09:00:00.000Z')
const MIN = 60_000

let repo: InMemoryCaseRepository
let publisher: RecordingPublisher
let clock: ManualClock
let deps: CaseWorkDeps
let decisionIds: number

const ALLOWED: Record<string, string[]> = {
  'scams_fraud.romance_scam': ['warn', 'suspend_7d', 'ban'],
  'spam_manipulation.spam': ['warn', 'hide_content'],
}

beforeEach(() => {
  repo = new InMemoryCaseRepository()
  publisher = new RecordingPublisher()
  clock = manualClock(T0)
  decisionIds = 0
  deps = {
    cases: repo,
    events: publisher,
    clock,
    newCaseId: () => 'case_unused',
    newDecisionId: () => `dec_${++decisionIds}`,
    catalog: { allowedActionKeys: async (_t, categoryId) => ALLOWED[categoryId] ?? null },
  }
})

const record = (o: Partial<CaseRecord> = {}): CaseRecord => ({
  id: 'case_1',
  appRef,
  subjectExternalId: 'u_5531',
  band: 'standard',
  state: 'open',
  reportIds: ['rpt_1'],
  openedAt: new Date('2026-11-02T00:00:00.000Z'),
  ...o,
})

const claimedBy = (memberId: string, lastActivityAt = T0, o: Partial<CaseRecord> = {}) =>
  record({ state: 'claimed', claim: { memberId, claimedAt: new Date(lastActivityAt.getTime() - MIN), lastActivityAt }, ...o })

const ref = (memberId = 'mem_jane') => ({ appRef, caseId: 'case_1', memberId })

async function rejectsWith(p: Promise<unknown>, code: string, extra: Partial<CaseWorkError> = {}) {
  const err = await p.then(
    () => expect.unreachable('should have thrown'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(CaseWorkError)
  expect(err).toMatchObject({ code, ...extra })
}

const decide = (o: Partial<DecideInput> = {}): DecideInput => ({
  ...ref(),
  outcome: 'violation',
  categoryId: 'scams_fraud.romance_scam',
  severity: 'P1',
  actionKeys: ['suspend_7d'],
  ...o,
})

describe('claimCase', () => {
  it.each<CaseState>(['open', 'untriaged'])('claims a case that is %s', async (state) => {
    repo.seed(record({ state }))
    const saved = await claimCase(deps, ref())
    expect(saved).toEqual(record({ state: 'claimed', claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 } }))
    expect(repo.get('case_1')).toEqual(saved)
    expect(publisher.events).toEqual([{ type: 'case.claimed', appRef, caseId: 'case_1', memberId: 'mem_jane', occurredAt: T0 }])
  })

  it('refreshes the activity of the member who holds it, without an event', async () => {
    repo.seed(claimedBy('mem_jane', new Date(T0.getTime() - 5 * MIN)))
    const saved = await claimCase(deps, ref())
    expect(saved.claim).toEqual({ memberId: 'mem_jane', claimedAt: new Date(T0.getTime() - 6 * MIN), lastActivityAt: T0 })
    expect(publisher.events).toEqual([])
  })

  it('refuses while someone else is active on it', async () => {
    repo.seed(claimedBy('mem_john', new Date(T0.getTime() - CLAIM_IDLE_MS + 1)))
    await rejectsWith(claimCase(deps, ref()), 'claimed_by_other', { holder: 'mem_john' })
    expect(repo.get('case_1')?.claim?.memberId).toBe('mem_john')
    expect(publisher.events).toEqual([])
  })

  it('takes over a claim idle for 15 minutes', async () => {
    repo.seed(claimedBy('mem_john', new Date(T0.getTime() - CLAIM_IDLE_MS)))
    const saved = await claimCase(deps, ref())
    expect(saved).toMatchObject({ state: 'claimed', claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 } })
    expect(publisher.events).toEqual([
      { type: 'case.released', appRef, caseId: 'case_1', memberId: 'mem_john', reason: 'idle', occurredAt: T0 },
      { type: 'case.claimed', appRef, caseId: 'case_1', memberId: 'mem_jane', occurredAt: T0 },
    ])
  })

  it.each<CaseState>(['classifying', 'decided', 'action_failed', 'actioned', 'appealed', 'closed'])('refuses a case that is %s', async (state) => {
    repo.seed(record({ state }))
    await rejectsWith(claimCase(deps, ref()), 'invalid_state')
  })

  it('reports a missing case, also in another appRef', async () => {
    await rejectsWith(claimCase(deps, ref()), 'not_found')
    repo.seed(record({ appRef: { ...appRef, appId: 'app_b' } }))
    await rejectsWith(claimCase(deps, ref()), 'not_found')
  })

  it('gives the slower of two moderators claiming at once claimed_by_other', async () => {
    repo.seed(record())
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.seed(claimedBy('mem_john'))
      }
    }
    await rejectsWith(claimCase(deps, ref()), 'claimed_by_other', { holder: 'mem_john' })
    expect(repo.get('case_1')?.claim?.memberId).toBe('mem_john')
    expect(publisher.events).toEqual([])
  })

  it('does not take over a claim whose holder became active meanwhile', async () => {
    repo.seed(claimedBy('mem_john', new Date(T0.getTime() - CLAIM_IDLE_MS)))
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.seed(claimedBy('mem_john', T0))
      }
    }
    await rejectsWith(claimCase(deps, ref()), 'claimed_by_other', { holder: 'mem_john' })
    expect(publisher.events).toEqual([])
  })

  it('refreshes activity without touching anything else', async () => {
    repo.seed(claimedBy('mem_jane', new Date(T0.getTime() - 5 * MIN), { reportIds: ['rpt_1', 'rpt_2'] }))
    await claimCase(deps, ref())
    expect(repo.get('case_1')).toMatchObject({ state: 'claimed', reportIds: ['rpt_1', 'rpt_2'], claim: { lastActivityAt: T0 } })
  })
})

describe('releaseCase', () => {
  it('releases the holder’s own claim back to open', async () => {
    repo.seed(claimedBy('mem_jane'))
    clock.advance(MIN)
    const saved = await releaseCase(deps, ref())
    expect(saved).toEqual(record({ state: 'open', claim: null }))
    expect(publisher.events).toEqual([
      { type: 'case.released', appRef, caseId: 'case_1', memberId: 'mem_jane', reason: 'released', occurredAt: new Date(T0.getTime() + MIN) },
    ])
  })

  it('refuses someone else’s claim unless forced', async () => {
    repo.seed(claimedBy('mem_john'))
    await rejectsWith(releaseCase(deps, ref()), 'claimed_by_other', { holder: 'mem_john' })
    const saved = await releaseCase(deps, { ...ref('mem_admin'), force: true })
    expect(saved.state).toBe('open')
    expect(publisher.events).toEqual([expect.objectContaining({ type: 'case.released', memberId: 'mem_john', reason: 'forced' })])
  })

  it('calls a forced release of your own claim a normal release', async () => {
    repo.seed(claimedBy('mem_jane'))
    await releaseCase(deps, { ...ref(), force: true })
    expect(publisher.events).toEqual([expect.objectContaining({ reason: 'released' })])
  })

  it('refuses a case that is not claimed, or missing', async () => {
    repo.seed(record({ state: 'open' }))
    await rejectsWith(releaseCase(deps, ref()), 'invalid_state')
    await rejectsWith(releaseCase(deps, { ...ref(), caseId: 'case_x' }), 'not_found')
  })
})

describe('decideCase', () => {
  it('records a violation with actions and publishes case.decided', async () => {
    repo.seed(claimedBy('mem_jane'))
    clock.advance(2 * MIN)
    const now = new Date(T0.getTime() + 2 * MIN)
    const decision = await decideCase(deps, decide({ publicReason: 'Asked a match for money.', internalNote: 'Same as last week.' }))
    const expected: Decision = {
      id: 'dec_1',
      outcome: 'violation',
      categoryId: 'scams_fraud.romance_scam',
      severity: 'P1',
      actionKeys: ['suspend_7d'],
      decidedBy: 'mem_jane',
      decidedAt: now,
      reportIds: ['rpt_1'],
      publicReason: 'Asked a match for money.',
      internalNote: 'Same as last week.',
    }
    expect(decision).toEqual(expected)
    expect(repo.get('case_1')).toEqual(record({ state: 'decided', claim: null, decision: expected }))
    expect(publisher.events).toEqual([
      {
        type: 'case.decided',
        appRef,
        caseId: 'case_1',
        subjectExternalId: 'u_5531',
        decisionId: 'dec_1',
        outcome: 'violation',
        categoryId: 'scams_fraud.romance_scam',
        severity: 'P1',
        actionKeys: ['suspend_7d'],
        reportIds: ['rpt_1'],
        decidedBy: 'mem_jane',
        occurredAt: now,
      },
    ])
  })

  it('moves straight to actioned when no action is requested', async () => {
    repo.seed(claimedBy('mem_jane'))
    const decision = await decideCase(deps, decide({ outcome: 'no_violation', actionKeys: [] }))
    expect(repo.get('case_1')?.state).toBe('actioned')
    expect(Object.keys(decision).sort()).toEqual(['actionKeys', 'categoryId', 'decidedAt', 'decidedBy', 'id', 'outcome', 'reportIds', 'severity'])
  })

  it('allows a violation with no action', async () => {
    repo.seed(claimedBy('mem_jane'))
    await decideCase(deps, decide({ actionKeys: [] }))
    expect(repo.get('case_1')?.state).toBe('actioned')
  })

  it('checks in order: missing, decided, not claimed, someone else’s claim', async () => {
    await rejectsWith(decideCase(deps, decide()), 'not_found')

    const earlier: Decision = { id: 'dec_0', outcome: 'violation', categoryId: 'x', severity: 'P2', actionKeys: [], decidedBy: 'mem_john', decidedAt: T0, reportIds: ['rpt_1'] }
    repo.seed(record({ state: 'actioned', decision: earlier }))
    await rejectsWith(decideCase(deps, decide()), 'already_decided', { decision: earlier })

    repo.seed(record({ state: 'open' }))
    await rejectsWith(decideCase(deps, decide()), 'not_claimed')

    repo.seed(claimedBy('mem_john'))
    await rejectsWith(decideCase(deps, decide()), 'claimed_by_other', { holder: 'mem_john' })
    expect(publisher.events).toEqual([])
  })

  it.each<[string, Partial<DecideInput>]>([
    ['no violation with actions', { outcome: 'no_violation', actionKeys: ['warn'] }],
    ['duplicate actions', { actionKeys: ['warn', 'warn'] }],
    ['an unknown category', { categoryId: 'made_up' }],
    ['an action the category does not allow', { categoryId: 'spam_manipulation.spam', actionKeys: ['ban'] }],
  ])('rejects %s', async (_label, patch) => {
    repo.seed(claimedBy('mem_jane'))
    await rejectsWith(decideCase(deps, decide(patch)), 'invalid_decision')
    expect(repo.get('case_1')?.state).toBe('claimed')
    expect(publisher.events).toEqual([])
  })

  it('gives the slower of two moderators the faster one’s decision', async () => {
    repo.seed(claimedBy('mem_jane'))
    const winner: Decision = {
      id: 'dec_john',
      outcome: 'no_violation',
      categoryId: 'scams_fraud.romance_scam',
      severity: 'P2',
      actionKeys: [],
      decidedBy: 'mem_john',
      decidedAt: T0,
      reportIds: ['rpt_1'],
    }
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.seed(record({ state: 'actioned', claim: null, decision: winner }))
      }
    }
    await rejectsWith(decideCase(deps, decide()), 'already_decided', { decision: winner })
    expect(repo.get('case_1')?.decision).toEqual(winner)
    expect(publisher.events).toEqual([])
  })

  it('is not disturbed by a report joining while the moderator decides', async () => {
    repo.seed(claimedBy('mem_jane'))
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.attachDirectly('case_1', 'rpt_2')
      }
    }
    await decideCase(deps, decide())
    expect(repo.get('case_1')).toMatchObject({ state: 'decided', reportIds: ['rpt_1', 'rpt_2'] })
    expect(repo.calls.filter((c) => c.method === 'change')).toHaveLength(1)
    expect(publisher.events).toHaveLength(1)
  })

  it('tries three times, then throws CaseChangedError', async () => {
    repo.seed(claimedBy('mem_jane'))
    repo.refuseChanges = 3
    await expect(decideCase(deps, decide())).rejects.toBeInstanceOf(CaseChangedError)
    expect(repo.calls.filter((c) => c.method === 'change')).toHaveLength(3)
    expect(publisher.events).toEqual([])
    repo.refuseChanges = 2
    await decideCase(deps, decide())
    expect(repo.get('case_1')?.state).toBe('decided')
  })
})
