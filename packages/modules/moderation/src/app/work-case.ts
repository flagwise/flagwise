// Claiming, releasing and deciding a case. Who may force a release is checked by the caller with
// can(). Every write is a conditional change that holds only if the case is still as it was read
// (e.g. still unclaimed); when it no longer is, the use case reads again and decides again, so the
// caller gets the real reason. Events are published only after the write succeeded. Failures throw
// CaseWorkError with a code, or CaseChangedError when the case kept changing after 3 attempts.

import type { TenantRef } from '@flagwise/kernel'
import { nextState } from '../domain/case-state.ts'
import { globalCategory, hasP0Signal } from '@flagwise/contracts'
import { CaseChangedError, type CaseRecord, type ModerationDeps, type CaseWorkDeps, type Decision, type Severity } from './ports.ts'

export const CLAIM_IDLE_MS = 15 * 60_000

export type CaseWorkErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'claimed_by_other'
  | 'not_claimed'
  | 'already_decided'
  | 'invalid_decision'
  | 'invalid_basis'
  | 'invalid_correction'

export class CaseWorkError extends Error {
  readonly code: CaseWorkErrorCode
  readonly holder: string | undefined
  readonly decision: Decision | undefined

  constructor(code: CaseWorkErrorCode, extra: { holder?: string; decision?: Decision } = {}) {
    super(code)
    this.name = 'CaseWorkError'
    this.code = code
    this.holder = extra.holder
    this.decision = extra.decision
  }
}

export interface CaseRef {
  readonly tenant: TenantRef
  readonly caseId: string
  readonly memberId: string
}

export interface DecideInput extends CaseRef {
  readonly outcome: Decision['outcome']
  readonly categoryId: string
  readonly severity: Severity
  readonly actionKeys: readonly string[]
  /** The reports shown to the moderator; default: the case's reports when the decision is made. */
  readonly reportIds?: readonly string[]
  readonly publicReason?: string
  readonly internalNote?: string
}

export interface CorrectInput extends CaseRef {
  readonly categoryId?: string
  readonly severity?: Severity
}

export interface RetryActionsInput extends CaseRef {
  /** One new request per key, in place of the failed ones; empty to accept the failures. */
  readonly actionKeys: readonly string[]
}

/** Runs `once` until it returns a result (not null), at most 3 times, then throws CaseChangedError. */
async function retrying<T>(caseId: string, once: () => Promise<T | null>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await once()
    if (result !== null) return result
  }
  throw new CaseChangedError(caseId)
}

/**
 * Claims a case for a member and returns the saved record.
 *
 * - No such case: 'not_found'.
 * - open or untriaged, and unclaimed: move to claimed, with `claim = { memberId, claimedAt: now,
 *   lastActivityAt: now }`; publish `case.claimed`.
 * - Claimed by the same member: refresh `claim.lastActivityAt` (no event).
 * - Claimed by someone else whose `lastActivityAt` is at least CLAIM_IDLE_MS ago: take it over
 *   (state stays claimed, new claim as above); publish `case.released` for the previous holder with
 *   reason 'idle', then `case.claimed`. Otherwise 'claimed_by_other', with `holder` set.
 * - Any other state: 'invalid_state'.
 *
 * Each write holds only while the case is as read (unclaimed, held by that member, or still idle);
 * otherwise it reads again and decides again.
 */
export function claimCase(deps: CaseWorkDeps, input: CaseRef): Promise<CaseRecord> {
  return retrying(input.caseId, () => claimOnce(deps, input))
}

async function claimOnce(deps: CaseWorkDeps, input: CaseRef): Promise<CaseRecord | null> {
  const { tenant, caseId, memberId } = input
  const current = await deps.cases.findById(tenant, caseId)
  if (!current) throw new CaseWorkError('not_found')
  const now = deps.clock.now()

  if (current.state === 'claimed' && current.claim?.memberId === memberId) {
    const claim = { ...current.claim, lastActivityAt: now }
    if (!(await deps.cases.change(tenant, caseId, { states: ['claimed'], claimedBy: memberId }, { claim }))) return null
    return { ...current, claim }
  }

  const claim = { memberId, claimedAt: now, lastActivityAt: now }
  if (current.state === 'claimed') {
    const holder = current.claim?.memberId
    if (holder === undefined) {
      // Claimed without a claim record: take it as unclaimed.
      if (!(await deps.cases.change(tenant, caseId, { states: ['claimed'], claimedBy: null }, { claim }))) return null
      await deps.events.publish({ type: 'case.claimed', tenant, caseId, memberId, occurredAt: now })
      return { ...current, claim }
    }
    const idleFor = now.getTime() - current.claim!.lastActivityAt.getTime()
    if (idleFor < CLAIM_IDLE_MS) throw new CaseWorkError('claimed_by_other', { holder })
    const idleSince = new Date(now.getTime() - CLAIM_IDLE_MS)
    if (!(await deps.cases.change(tenant, caseId, { states: ['claimed'], claimedBy: holder, claimIdleSince: idleSince }, { claim }))) return null
    await deps.events.publish({ type: 'case.released', tenant, caseId, memberId: holder, reason: 'idle', occurredAt: now })
    await deps.events.publish({ type: 'case.claimed', tenant, caseId, memberId, occurredAt: now })
    return { ...current, claim }
  }

  if (current.state !== 'open' && current.state !== 'untriaged') throw new CaseWorkError('invalid_state')
  const state = nextState(current.state, { type: 'claimed' })
  if (!(await deps.cases.change(tenant, caseId, { states: [current.state], claimedBy: null }, { state, claim }))) return null
  await deps.events.publish({ type: 'case.claimed', tenant, caseId, memberId, occurredAt: now })
  return { ...current, state, claim }
}

/**
 * Releases a claim back to open and returns the saved record.
 *
 * - No such case: 'not_found'; not claimed: 'invalid_state'.
 * - Held by someone else and `force` is not true: 'claimed_by_other' (with `holder`).
 * - Otherwise move to open, set `claim` to null and publish `case.released` with `memberId` = the
 *   previous holder and reason 'forced' when force was used on someone else's claim, else
 *   'released'.
 *
 * The write holds only while the same member still holds the claim; otherwise it reads again.
 */
export function releaseCase(deps: CaseWorkDeps, input: CaseRef & { readonly force?: boolean }): Promise<CaseRecord> {
  return retrying(input.caseId, () => releaseOnce(deps, input))
}

async function releaseOnce(deps: CaseWorkDeps, input: CaseRef & { readonly force?: boolean }): Promise<CaseRecord | null> {
  const { tenant, caseId, memberId } = input
  const current = await deps.cases.findById(tenant, caseId)
  if (!current) throw new CaseWorkError('not_found')
  if (current.state !== 'claimed' || !current.claim) throw new CaseWorkError('invalid_state')

  const holder = current.claim.memberId
  const foreign = holder !== memberId
  if (foreign && input.force !== true) throw new CaseWorkError('claimed_by_other', { holder })

  const now = deps.clock.now()
  const state = nextState(current.state, { type: 'released' })
  if (!(await deps.cases.change(tenant, caseId, { states: ['claimed'], claimedBy: holder }, { state, claim: null }))) return null
  await deps.events.publish({ type: 'case.released', tenant, caseId, memberId: holder, reason: foreign ? 'forced' : 'released', occurredAt: now })
  return { ...current, state, claim: null }
}

/**
 * Records a decision and returns it. Checks, in order:
 *
 * 1. no such case: 'not_found'
 * 2. the case already has a decision: 'already_decided', with `decision` set to it
 * 3. the state is not claimed: 'not_claimed'
 * 4. the claim belongs to someone else: 'claimed_by_other' (with `holder`)
 * 5. 'invalid_decision' when the outcome is 'no_violation' but actionKeys is not empty, actionKeys
 *    has duplicates, the catalog does not know the category, or an action key is not allowed for it.
 * 6. 'invalid_basis' when reportIds is empty, has duplicates or names a report not in the case.
 *
 * Then: `decision = { id: newDecisionId(), outcome, categoryId, severity, actionKeys, decidedBy:
 * memberId, decidedAt: now, reportIds, publicReason?, internalNote? }` (optional fields only when
 * given; reportIds in the case's order, all of the case's reports when not given); the
 * state moves by `decided` with `actionCount = actionKeys.length`; claim null. Publishes
 * `case.decided` with the case's subject.
 *
 * The write holds only while the case is still claimed by this member. Two moderators deciding at
 * once: the slower one reads again and gets 'already_decided' with the faster one's decision.
 */
export function decideCase(deps: CaseWorkDeps, input: DecideInput): Promise<Decision> {
  return retrying(input.caseId, () => decideOnce(deps, input))
}

async function decideOnce(deps: CaseWorkDeps, input: DecideInput): Promise<Decision | null> {
  const { tenant, caseId, memberId, outcome, categoryId, severity, actionKeys } = input
  const current = await deps.cases.findById(tenant, caseId)
  if (!current) throw new CaseWorkError('not_found')
  if (current.decision) throw new CaseWorkError('already_decided', { decision: current.decision })
  if (current.state !== 'claimed') throw new CaseWorkError('not_claimed')
  if (current.claim?.memberId !== memberId) {
    throw new CaseWorkError('claimed_by_other', current.claim ? { holder: current.claim.memberId } : {})
  }

  const allowed = await deps.catalog.allowedActionKeys(tenant, categoryId)
  const invalid =
    (outcome === 'no_violation' && actionKeys.length > 0) ||
    new Set(actionKeys).size !== actionKeys.length ||
    allowed === null ||
    actionKeys.some((k) => !allowed.includes(k))
  if (invalid) throw new CaseWorkError('invalid_decision')
  const reportIds = input.reportIds ?? current.reportIds
  if (reportIds.length === 0 || new Set(reportIds).size !== reportIds.length || reportIds.some((id) => !current.reportIds.includes(id))) {
    throw new CaseWorkError('invalid_basis')
  }

  const now = deps.clock.now()
  const decision: Decision = {
    id: deps.newDecisionId(),
    outcome,
    categoryId,
    severity,
    actionKeys,
    decidedBy: memberId,
    decidedAt: now,
    reportIds: current.reportIds.filter((id) => reportIds.includes(id)),
    ...(input.publicReason !== undefined && { publicReason: input.publicReason }),
    ...(input.internalNote !== undefined && { internalNote: input.internalNote }),
  }
  const state = nextState(current.state, { type: 'decided', actionCount: actionKeys.length })
  if (!(await deps.cases.change(tenant, caseId, { states: ['claimed'], claimedBy: memberId }, { state, claim: null, decision }))) return null
  await deps.events.publish({
    type: 'case.decided',
    tenant,
    caseId,
    subjectExternalId: current.subjectExternalId,
    decisionId: decision.id,
    outcome,
    categoryId,
    severity,
    actionKeys,
    reportIds: decision.reportIds,
    decidedBy: memberId,
    occurredAt: now,
  })
  return decision
}

/**
 * Changes a classified case's category and/or severity before it is decided, and returns the saved
 * record; triage then triages it again from `case.corrected` and moderation saves the priority and
 * SLA it publishes. Checks, in order: no such case, 'not_found'; not claimed, 'not_claimed';
 * claimed by someone else, 'claimed_by_other' (with `holder`); no classification, 'invalid_state'.
 *
 * 'invalid_correction' when the category is not a global category, when the given severity is not
 * P0 although the case must be (a P0 global category, a P0 signal or the pre-rules' P0), or when
 * the correction would lower a P0 case: P0 reports are never downgraded. Without a severity, a new
 * category gives the case P0 when it must be, else the category's own. A case claimed from
 * untriaged has no triage yet: the correction asks triage to triage it, so it runs even when
 * nothing changes, and `before.severity` is null.
 *
 * The case keeps its state and claim (with `lastActivityAt` refreshed); a new category replaces
 * the classification's and drops the app's custom category, and a known severity replaces the
 * triage's until triage answers. `case.corrected` carries before and after (the severity the
 * moderator gave, or null). On a triaged case, when neither category nor severity changes,
 * nothing is written or published. The write holds only while the member still holds the claim.
 */
export function correctCase(deps: ModerationDeps, input: CorrectInput): Promise<CaseRecord> {
  return retrying(input.caseId, () => correctOnce(deps, input))
}

async function correctOnce(deps: ModerationDeps, input: CorrectInput): Promise<CaseRecord | null> {
  const { tenant, caseId, memberId } = input
  const current = await deps.cases.findById(tenant, caseId)
  if (!current) throw new CaseWorkError('not_found')
  if (current.state !== 'claimed') throw new CaseWorkError('not_claimed')
  if (current.claim?.memberId !== memberId) throw new CaseWorkError('claimed_by_other', current.claim ? { holder: current.claim.memberId } : {})
  if (!current.classification) throw new CaseWorkError('invalid_state')

  const before = { categoryId: current.classification.categoryId, severity: current.triage?.severity ?? null }
  const categoryId = input.categoryId ?? before.categoryId
  const moved = categoryId !== before.categoryId
  if (current.triage && !moved && (input.severity === undefined || input.severity === before.severity)) return current

  const category = globalCategory(categoryId)
  if (!category) throw new CaseWorkError('invalid_correction')
  const mustBeP0 = category.severity === 'P0' || hasP0Signal(current.classification.signals) || current.band === 'p0'
  if (input.severity !== undefined && input.severity !== 'P0' && mustBeP0) throw new CaseWorkError('invalid_correction')
  const severity = input.severity ?? (moved ? (mustBeP0 ? 'P0' : category.severity) : before.severity)
  if (before.severity === 'P0' && severity !== 'P0') throw new CaseWorkError('invalid_correction')

  const now = deps.clock.now()
  const claim = { ...current.claim, lastActivityAt: now }
  const { customCategoryId: _custom, ...global } = current.classification
  const classification = moved ? { ...global, categoryId } : current.classification
  const triage = current.triage && severity !== null ? { ...current.triage, severity } : current.triage
  if (!(await deps.cases.change(tenant, caseId, { states: ['claimed'], claimedBy: memberId }, { claim, classification, ...(triage && { triage }) }))) return null
  await deps.events.publish({
    type: 'case.corrected',
    tenant,
    caseId,
    before,
    after: { categoryId, severity: input.severity ?? null },
    correctedBy: memberId,
    occurredAt: now,
  })
  return { ...current, claim, classification, ...(triage && { triage }) }
}

/**
 * Answers the failed actions of a case in action_failed, and returns the saved record: the case
 * moves back to decided, its noted failures no retry answered yet are answered, and
 * `case.actions_retried` names them in `replaces`. Delivery replaces those requests with one per
 * action key (the same key retries it; an empty list accepts the failures, and the case becomes
 * actioned once the remaining actions are confirmed). No claim is needed: a decided
 * case has none. Checks, in order: no such case, 'not_found'; not in action_failed,
 * 'invalid_state'; 'invalid_decision' when actionKeys has duplicates or a key the decision's
 * category does not allow. The write holds only while the case is still in action_failed with
 * the same decision.
 */
export function retryActions(deps: CaseWorkDeps, input: RetryActionsInput): Promise<CaseRecord> {
  return retrying(input.caseId, () => retryOnce(deps, input))
}

async function retryOnce(deps: CaseWorkDeps, input: RetryActionsInput): Promise<CaseRecord | null> {
  const { tenant, caseId, memberId, actionKeys } = input
  const current = await deps.cases.findById(tenant, caseId)
  if (!current) throw new CaseWorkError('not_found')
  const decision = current.decision
  if (current.state !== 'action_failed' || !decision) throw new CaseWorkError('invalid_state')

  const allowed = await deps.catalog.allowedActionKeys(tenant, decision.categoryId)
  const invalid = new Set(actionKeys).size !== actionKeys.length || (actionKeys.length > 0 && (allowed === null || actionKeys.some((k) => !allowed.includes(k))))
  if (invalid) throw new CaseWorkError('invalid_decision')

  const now = deps.clock.now()
  const state = nextState(current.state, { type: 'action_retried' })
  if (!(await deps.cases.change(tenant, caseId, { states: ['action_failed'], decisionId: decision.id }, { state }))) return null
  const replaces = await deps.cases.openActionFailures(tenant, caseId)
  await deps.cases.answerActionFailures(tenant, caseId, replaces)
  await deps.events.publish({
    type: 'case.actions_retried',
    tenant,
    caseId,
    decisionId: decision.id,
    subjectExternalId: current.subjectExternalId,
    categoryId: decision.categoryId,
    severity: decision.severity,
    actionKeys,
    replaces,
    retriedBy: memberId,
    occurredAt: now,
  })
  return { ...current, state }
}
