// Filing and resolving appeals. Failures throw AppealError with a code. Events are published only
// after the write succeeded.

import type { TenantRef } from '@flagwise/kernel'
import { VersionConflictError, type AppealRecord, type AppealsDeps, type Appellant } from './ports.ts'

export const APPEAL_WINDOW_MONTHS = 6
export const APPEAL_SLA_MS = 7 * 86_400_000
export const MAX_APPEAL_TEXT = 2000

export type AppealErrorCode =
  | 'decision_not_found'
  | 'invalid_text'
  | 'not_a_party'
  | 'nothing_to_appeal'
  | 'window_closed'
  | 'already_appealed'
  | 'appeal_not_found'
  | 'already_resolved'
  | 'reviewer_is_decider'

export class AppealError extends Error {
  readonly code: AppealErrorCode
  constructor(code: AppealErrorCode) {
    super(code)
    this.name = 'AppealError'
    this.code = code
  }
}

export interface FileAppealInput {
  readonly tenant: TenantRef
  readonly decisionId: string
  readonly appellant: Appellant
  readonly appellantExternalId: string
  readonly text: string
}

export interface ResolveAppealInput {
  readonly tenant: TenantRef
  readonly appealId: string
  readonly reviewerId: string
  readonly outcome: 'upheld' | 'overturned'
}

/**
 * APPEAL_WINDOW_MONTHS calendar months after `decidedAt`, in UTC, same time of day. When that day
 * does not exist in the target month, the last day of that month (Aug 31 -> Feb 28, or Feb 29 in a
 * leap year). An appeal at exactly the deadline is accepted.
 */
export function appealDeadline(decidedAt: Date): Date {
  const total = decidedAt.getUTCFullYear() * 12 + decidedAt.getUTCMonth() + APPEAL_WINDOW_MONTHS
  const year = Math.floor(total / 12)
  const month = total % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const result = new Date(decidedAt.getTime())
  result.setUTCFullYear(year, month, Math.min(decidedAt.getUTCDate(), lastDay))
  return result
}

/**
 * Files an appeal and returns the new record. Checks, in order:
 *
 * 1. 'decision_not_found': no such decision in the tenant
 * 2. 'invalid_text': the trimmed text is empty or longer than MAX_APPEAL_TEXT characters
 * 3. 'not_a_party': appellant 'reported' but not the decision's subject, or 'reporter' but not one
 *    of its reporters
 * 4. 'nothing_to_appeal': the reported user appeals 'no_violation', or a reporter appeals 'violation'
 * 5. 'window_closed': now is after appealDeadline(decidedAt)
 * 6. 'already_appealed': this person already appealed this decision (one appeal per party per
 *    decision, whatever its status)
 *
 * The record keeps the trimmed text, `filedAt` now, `dueAt` now + APPEAL_SLA_MS, status 'open',
 * version 1. Publishes `appeal.filed`.
 */
export async function fileAppeal(deps: AppealsDeps, input: FileAppealInput): Promise<AppealRecord> {
  const decision = await deps.decisions.findById(input.tenant, input.decisionId)
  if (!decision) throw new AppealError('decision_not_found')

  const text = input.text.trim()
  if (text.length === 0 || text.length > MAX_APPEAL_TEXT) throw new AppealError('invalid_text')

  const isParty =
    input.appellant === 'reported'
      ? input.appellantExternalId === decision.subjectExternalId
      : decision.reporterExternalIds.includes(input.appellantExternalId)
  if (!isParty) throw new AppealError('not_a_party')

  const wanted = input.appellant === 'reported' ? 'violation' : 'no_violation'
  if (decision.outcome !== wanted) throw new AppealError('nothing_to_appeal')

  const now = deps.clock.now()
  if (now.getTime() > appealDeadline(decision.decidedAt).getTime()) throw new AppealError('window_closed')

  const existing = await deps.appeals.findByDecision(input.tenant, input.decisionId)
  if (existing.some((a) => a.appellant === input.appellant && a.appellantExternalId === input.appellantExternalId)) {
    throw new AppealError('already_appealed')
  }

  const record: AppealRecord = {
    id: deps.newAppealId(),
    tenant: input.tenant,
    decisionId: decision.decisionId,
    caseId: decision.caseId,
    appellant: input.appellant,
    appellantExternalId: input.appellantExternalId,
    text,
    filedAt: now,
    dueAt: new Date(now.getTime() + APPEAL_SLA_MS),
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    version: 1,
  }
  await deps.appeals.insert(record)
  await deps.events.publish({
    type: 'appeal.filed',
    tenant: input.tenant,
    appealId: record.id,
    decisionId: record.decisionId,
    caseId: record.caseId,
    appellant: record.appellant,
    dueAt: record.dueAt,
    occurredAt: now,
  })
  return record
}

/**
 * Resolves an appeal and returns the saved record. Checks, in order:
 *
 * 1. 'appeal_not_found'
 * 2. 'already_resolved': status is not 'open'
 * 3. 'decision_not_found': the appeal's decision is missing (nothing is written: without it the
 *    reviewer and the actions to reverse are unknown)
 * 4. 'reviewer_is_decider': the reviewer made the decision
 *
 * Saves status = outcome, resolvedBy, resolvedAt now, version + 1. On VersionConflictError it reads
 * again and redoes the checks once (a second reviewer then gets 'already_resolved'); a second
 * conflict is thrown. Publishes `appeal.resolved`:
 * - upheld: no keys, revokePoints false, reopenCase false;
 * - overturned for the reported user: each of the decision's action keys, in order, goes to
 *   reverseActionKeys as its reverse key, or to irreversibleActionKeys when it has none;
 *   revokePoints true;
 * - overturned for a reporter: no keys, reopenCase true.
 */
export async function resolveAppeal(deps: AppealsDeps, input: ResolveAppealInput): Promise<AppealRecord> {
  for (let attempt = 1; ; attempt++) {
    const appeal = await deps.appeals.findById(input.tenant, input.appealId)
    if (!appeal) throw new AppealError('appeal_not_found')
    if (appeal.status !== 'open') throw new AppealError('already_resolved')
    const decision = await deps.decisions.findById(input.tenant, appeal.decisionId)
    if (!decision) throw new AppealError('decision_not_found')
    if (decision.decidedBy === input.reviewerId) throw new AppealError('reviewer_is_decider')

    const now = deps.clock.now()
    const saved: AppealRecord = {
      ...appeal,
      status: input.outcome,
      resolvedBy: input.reviewerId,
      resolvedAt: now,
      version: appeal.version + 1,
    }
    try {
      await deps.appeals.update(saved, appeal.version)
    } catch (err) {
      if (err instanceof VersionConflictError && attempt < 2) continue
      throw err
    }

    const reverseActionKeys: string[] = []
    const irreversibleActionKeys: string[] = []
    const overturnedSanction = input.outcome === 'overturned' && appeal.appellant === 'reported'
    if (overturnedSanction) {
      for (const key of decision.actionKeys) {
        const reverse = await deps.reverseKeys.reverseOf(input.tenant, key)
        if (reverse === null) irreversibleActionKeys.push(key)
        else reverseActionKeys.push(reverse)
      }
    }
    await deps.events.publish({
      type: 'appeal.resolved',
      tenant: input.tenant,
      appealId: saved.id,
      decisionId: saved.decisionId,
      caseId: saved.caseId,
      outcome: input.outcome,
      reverseActionKeys,
      irreversibleActionKeys,
      revokePoints: overturnedSanction,
      reopenCase: input.outcome === 'overturned' && appeal.appellant === 'reporter',
      resolvedBy: input.reviewerId,
      occurredAt: now,
    })
    return saved
  }
}
