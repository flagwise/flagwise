import { describe, expect, it } from 'vitest'
import {
  CASE_STATES,
  InvalidTransitionError,
  acceptsNewReports,
  canApply,
  isInQueue,
  nextState,
  type CaseState,
  type CaseTransition,
} from '../src/domain/case-state.ts'

const t = {
  triaged: { type: 'triaged' },
  marked_untriaged: { type: 'marked_untriaged' },
  classify_retried: { type: 'classify_retried' },
  claimed: { type: 'claimed' },
  released: { type: 'released' },
  decidedWithActions: { type: 'decided', actionCount: 2 },
  decidedNoAction: { type: 'decided', actionCount: 0 },
  actions_confirmed: { type: 'actions_confirmed' },
  action_failed: { type: 'action_failed' },
  action_retried: { type: 'action_retried' },
  appeal_filed: { type: 'appeal_filed' },
  appeal_resolved: { type: 'appeal_resolved' },
  closed: { type: 'closed' },
} satisfies Record<string, CaseTransition>

const ALL_TRANSITIONS: CaseTransition[] = Object.values(t)

// [from, transition, to]: every allowed move
const ALLOWED: [CaseState, CaseTransition, CaseState][] = [
  ['classifying', t.triaged, 'open'],
  ['classifying', t.marked_untriaged, 'untriaged'],
  ['untriaged', t.classify_retried, 'classifying'],
  ['untriaged', t.claimed, 'claimed'],
  ['open', t.claimed, 'claimed'],
  ['claimed', t.released, 'open'],
  ['claimed', t.decidedWithActions, 'decided'],
  ['claimed', t.decidedNoAction, 'actioned'],
  ['decided', t.actions_confirmed, 'actioned'],
  ['decided', t.action_failed, 'action_failed'],
  ['action_failed', t.action_retried, 'decided'],
  ['action_failed', t.actions_confirmed, 'actioned'],
  ['actioned', t.appeal_filed, 'appealed'],
  ['actioned', t.closed, 'closed'],
  ['appealed', t.appeal_resolved, 'actioned'],
]

const label = (tr: CaseTransition) => (tr.type === 'decided' ? `decided(${tr.actionCount})` : tr.type)

describe('nextState', () => {
  it.each(ALLOWED.map(([from, tr, to]) => [from, label(tr), to, tr] as const))(
    '%s --%s--> %s',
    (from, _l, to, tr) => {
      expect(nextState(from, tr)).toBe(to)
    },
  )

  const allowedKeys = new Set(ALLOWED.map(([from, tr]) => `${from}|${label(tr)}`))
  const forbidden = CASE_STATES.flatMap((from) =>
    ALL_TRANSITIONS.filter((tr) => !allowedKeys.has(`${from}|${label(tr)}`)).map((tr) => [from, label(tr), tr] as const),
  )

  it.each(forbidden)('rejects %s --%s-->', (from, _l, tr) => {
    expect(() => nextState(from, tr)).toThrow(InvalidTransitionError)
  })

  it('reports the state and transition it rejected', () => {
    try {
      nextState('closed', t.claimed)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError)
      expect((err as InvalidTransitionError).from).toBe('closed')
      expect((err as InvalidTransitionError).transition).toBe('claimed')
    }
  })

  it('never leaves closed', () => {
    for (const tr of ALL_TRANSITIONS) expect(() => nextState('closed', tr)).toThrow(InvalidTransitionError)
  })

  it.each([-1, 1.5, Number.NaN])('rejects a decision with actionCount %s', (actionCount) => {
    expect(() => nextState('claimed', { type: 'decided', actionCount })).toThrow(InvalidTransitionError)
  })

  it('follows a full case life: report, triage, claim, decide, confirm, appeal, close', () => {
    const path: CaseTransition[] = [
      t.triaged,
      t.claimed,
      t.released,
      t.claimed,
      t.decidedWithActions,
      t.action_failed,
      t.action_retried,
      t.actions_confirmed,
      t.appeal_filed,
      t.appeal_resolved,
      t.closed,
    ]
    expect(path.reduce<CaseState>(nextState, 'classifying')).toBe('closed')
  })
})

describe('canApply', () => {
  it('agrees with nextState for every state and transition', () => {
    for (const from of CASE_STATES) {
      for (const tr of [...ALL_TRANSITIONS, { type: 'decided', actionCount: -1 } as const]) {
        let ok = true
        try {
          nextState(from, tr)
        } catch {
          ok = false
        }
        expect(canApply(from, tr), `${from} ${label(tr)}`).toBe(ok)
      }
    }
  })
})

describe('isInQueue', () => {
  it.each(CASE_STATES.map((s) => [s, ['untriaged', 'open', 'claimed'].includes(s)] as const))('%s: %s', (state, expected) => {
    expect(isInQueue(state)).toBe(expected)
  })
})

describe('acceptsNewReports', () => {
  const accepting = ['classifying', 'untriaged', 'open', 'claimed']
  it.each(CASE_STATES.map((s) => [s, accepting.includes(s)] as const))('%s: %s', (state, expected) => {
    expect(acceptsNewReports(state)).toBe(expected)
  })
})
