// The case lifecycle as a pure state machine.

export const CASE_STATES = [
  'classifying',
  'untriaged',
  'open',
  'claimed',
  'decided',
  'action_failed',
  'actioned',
  'appealed',
  'closed',
] as const
export type CaseState = (typeof CASE_STATES)[number]

export type CaseTransition =
  | { readonly type: 'triaged' }
  | { readonly type: 'marked_untriaged' }
  | { readonly type: 'classify_retried' }
  | { readonly type: 'claimed' }
  | { readonly type: 'released' }
  | { readonly type: 'decided'; readonly actionCount: number }
  | { readonly type: 'actions_confirmed' }
  | { readonly type: 'action_failed' }
  | { readonly type: 'action_retried' }
  | { readonly type: 'appeal_filed' }
  | { readonly type: 'appeal_resolved' }
  | { readonly type: 'closed' }

export class InvalidTransitionError extends Error {
  readonly from: CaseState
  readonly transition: CaseTransition['type']

  constructor(from: CaseState, transition: CaseTransition['type']) {
    super(`Cannot apply ${transition} to a case in ${from}`)
    this.name = 'InvalidTransitionError'
    this.from = from
    this.transition = transition
  }
}

/**
 * The state after applying `transition`, or an InvalidTransitionError for any move not listed:
 *
 *     from           transition         to             when
 *     classifying    triaged            open           classify (or the rules-only fallback) and triage done
 *     classifying    marked_untriaged   untriaged      every LLM route failed and the fallback is off
 *     untriaged      classify_retried   classifying    LLM classify is retried
 *     untriaged      claimed            claimed        a moderator claims it for manual triage
 *     open           claimed            claimed        a moderator claims it
 *     claimed        released           open           released, or auto-released after idle time
 *     claimed        decided            decided        decision with one or more action keys
 *     claimed        decided            actioned       decision with no action keys (actionCount = 0)
 *     decided        actions_confirmed  actioned       the tenant confirmed every requested action
 *     decided        action_failed      action_failed  the tenant reported a failure, or delivery gave up
 *     action_failed  action_retried     decided        a moderator retries or picks another action
 *     action_failed  actions_confirmed  actioned       the remaining actions were confirmed
 *     actioned       appeal_filed       appealed       a party filed an appeal
 *     actioned       closed             closed         the appeal window passed
 *     appealed       appeal_resolved    actioned       the appeal was upheld or overturned
 *
 * `closed` is terminal: a later report opens a new case. A `decided` transition with a negative or
 * non-integer actionCount also throws InvalidTransitionError.
 */
export function nextState(state: CaseState, transition: CaseTransition): CaseState {
  const to = target(state, transition)
  if (to === undefined) throw new InvalidTransitionError(state, transition.type)
  return to
}

function target(state: CaseState, t: CaseTransition): CaseState | undefined {
  switch (state) {
    case 'classifying':
      if (t.type === 'triaged') return 'open'
      if (t.type === 'marked_untriaged') return 'untriaged'
      return undefined
    case 'untriaged':
      if (t.type === 'classify_retried') return 'classifying'
      if (t.type === 'claimed') return 'claimed'
      return undefined
    case 'open':
      return t.type === 'claimed' ? 'claimed' : undefined
    case 'claimed':
      if (t.type === 'released') return 'open'
      if (t.type === 'decided') {
        if (!Number.isInteger(t.actionCount) || t.actionCount < 0) return undefined
        return t.actionCount === 0 ? 'actioned' : 'decided'
      }
      return undefined
    case 'decided':
      if (t.type === 'actions_confirmed') return 'actioned'
      if (t.type === 'action_failed') return 'action_failed'
      return undefined
    case 'action_failed':
      if (t.type === 'action_retried') return 'decided'
      if (t.type === 'actions_confirmed') return 'actioned'
      return undefined
    case 'actioned':
      if (t.type === 'appeal_filed') return 'appealed'
      if (t.type === 'closed') return 'closed'
      return undefined
    case 'appealed':
      return t.type === 'appeal_resolved' ? 'actioned' : undefined
    case 'closed':
      return undefined
  }
}

/** True exactly when nextState would not throw. */
export function canApply(state: CaseState, transition: CaseTransition): boolean {
  return target(state, transition) !== undefined
}

/** The moderator queue shows untriaged, open and claimed cases. */
export function isInQueue(state: CaseState): boolean {
  return state === 'untriaged' || state === 'open' || state === 'claimed'
}

/**
 * A new report on the same account may join a case that is classifying, untriaged, open or claimed.
 * A decision covers the reports it was made on, so a report after it opens a new case.
 */
export function acceptsNewReports(state: CaseState): boolean {
  return (ACCEPTS_REPORTS as readonly CaseState[]).includes(state)
}

/** The states in which a case accepts new reports (see acceptsNewReports). */
export const ACCEPTS_REPORTS = ['classifying', 'untriaged', 'open', 'claimed'] as const satisfies readonly CaseState[]
