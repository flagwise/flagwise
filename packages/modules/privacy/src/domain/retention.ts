// Retention: decides which stored items of one app the daily purge deletes now. Pure; deleting is
// done elsewhere.

export type DataKind = 'evidence' | 'notice' | 'appeal' | 'audit'

export interface StoredItem {
  readonly id: string
  readonly kind: DataKind
  readonly livemode: boolean
  readonly createdAt: Date
  readonly caseId?: string
  readonly subjectId?: string
  /** Evidence only: when the case was closed; null or missing while it is open. */
  readonly caseClosedAt?: Date | null | undefined
  /** Audit only: position in the app's audit chain. */
  readonly seq?: number
}

export interface RetentionPolicy {
  readonly evidenceDaysAfterClose: number
  readonly noticeDays: number
  readonly appealDays: number
  readonly auditDays: number
  readonly testDataDays: number
  /** Plan maximum for live data (e.g. 365 on Free), or null for none. */
  readonly maxDays: number | null
}

/** Default retention: evidence 1 year after the case closes, notices, appeals and audit 2 years, test data 30 days. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  evidenceDaysAfterClose: 365,
  noticeDays: 730,
  appealDays: 730,
  auditDays: 730,
  testDataDays: 30,
  maxDays: null,
}

export interface LegalHolds {
  readonly caseIds: readonly string[]
  readonly subjectIds: readonly string[]
}

export type KeepReason = 'legal_hold' | 'case_open' | 'not_due' | 'audit_order'

export interface PurgePlan {
  readonly purge: readonly string[]
  readonly kept: readonly { readonly id: string; readonly reason: KeepReason; readonly dueAt: Date | null }[]
  readonly nextDueAt: Date | null
  readonly auditCheckpoint: { readonly live: number | null; readonly test: number | null }
}

/**
 * The purge plan for one app at `now`.
 *
 * Validation (RangeError): every day count is a positive integer; `maxDays` is null or a positive
 * integer; item ids are unique; every audit item has a positive integer `seq`, unique within its
 * livemode.
 *
 * Due time (DAY = 86_400_000 ms): test data (livemode false), any kind: createdAt + testDataDays.
 * Live evidence: caseClosedAt + evidenceDaysAfterClose days, or none while the case is open. Live
 * notice, appeal, audit: createdAt + noticeDays / appealDays / auditDays. Live day counts are
 * capped at `maxDays` when set (the plan's maximum); the cap does not apply to test data.
 *
 * Decision per item, first match wins: 'legal_hold' (its caseId or subjectId is held);
 * 'case_open' (no due time); purge (now >= due time); 'not_due'. Then audit entries, one chain per
 * livemode, are purged oldest first only: going through each chain by ascending seq, once one entry
 * is kept, every later entry that would have been purged is kept as 'audit_order'.
 *
 * Result: `purge` (ids, input order); `kept` (`{ id, reason, dueAt }`, input order); `nextDueAt`
 * (earliest dueAt among 'not_due' items, or null); `auditCheckpoint` (`{ live, test }`, the highest
 * purged audit seq per chain or null, from which the chain is verified after a purge).
 */
export function planPurge(
  _items: readonly StoredItem[],
  _policy: RetentionPolicy,
  _holds: LegalHolds,
  _now: Date,
): PurgePlan {
  const posInt = (n: number) => Number.isInteger(n) && n > 0
  const days = [_policy.evidenceDaysAfterClose, _policy.noticeDays, _policy.appealDays, _policy.auditDays, _policy.testDataDays]
  if (!days.every(posInt)) throw new RangeError('day counts must be positive integers')
  if (_policy.maxDays !== null && !posInt(_policy.maxDays)) throw new RangeError('maxDays must be null or a positive integer')
  const ids = new Set<string>()
  const seqs = { live: new Set<number>(), test: new Set<number>() }
  for (const item of _items) {
    if (ids.has(item.id)) throw new RangeError(`duplicate item id: ${item.id}`)
    ids.add(item.id)
    if (item.kind === 'audit') {
      if (item.seq === undefined || !posInt(item.seq)) throw new RangeError(`invalid audit seq: ${item.id}`)
      const chain = item.livemode ? seqs.live : seqs.test
      if (chain.has(item.seq)) throw new RangeError(`duplicate audit seq: ${item.id}`)
      chain.add(item.seq)
    }
  }

  const DAY = 86_400_000
  const nowMs = _now.getTime()
  const cap = (d: number) => (_policy.maxDays === null ? d : Math.min(d, _policy.maxDays))
  const dueOf = (item: StoredItem): Date | null => {
    if (!item.livemode) return new Date(item.createdAt.getTime() + _policy.testDataDays * DAY)
    switch (item.kind) {
      case 'evidence':
        return item.caseClosedAt ? new Date(item.caseClosedAt.getTime() + cap(_policy.evidenceDaysAfterClose) * DAY) : null
      case 'notice':
        return new Date(item.createdAt.getTime() + cap(_policy.noticeDays) * DAY)
      case 'appeal':
        return new Date(item.createdAt.getTime() + cap(_policy.appealDays) * DAY)
      case 'audit':
        return new Date(item.createdAt.getTime() + cap(_policy.auditDays) * DAY)
    }
  }

  const caseHolds = new Set(_holds.caseIds)
  const subjectHolds = new Set(_holds.subjectIds)
  const decisions = new Map<string, { reason: KeepReason | 'purge'; dueAt: Date | null }>()
  for (const item of _items) {
    const dueAt = dueOf(item)
    let reason: KeepReason | 'purge'
    if ((item.caseId !== undefined && caseHolds.has(item.caseId)) || (item.subjectId !== undefined && subjectHolds.has(item.subjectId))) {
      reason = 'legal_hold'
    } else if (dueAt === null) reason = 'case_open'
    else if (nowMs >= dueAt.getTime()) reason = 'purge'
    else reason = 'not_due'
    decisions.set(item.id, { reason, dueAt })
  }

  const checkpoint: { live: number | null; test: number | null } = { live: null, test: null }
  for (const livemode of [true, false]) {
    const chain = _items.filter((i) => i.kind === 'audit' && i.livemode === livemode).sort((a, b) => a.seq! - b.seq!)
    let blocked = false
    for (const item of chain) {
      const d = decisions.get(item.id)!
      if (d.reason !== 'purge') blocked = true
      else if (blocked) d.reason = 'audit_order'
      else checkpoint[livemode ? 'live' : 'test'] = item.seq!
    }
  }

  const purge: string[] = []
  const kept: { id: string; reason: KeepReason; dueAt: Date | null }[] = []
  let nextDueAt: Date | null = null
  for (const item of _items) {
    const d = decisions.get(item.id)!
    if (d.reason === 'purge') {
      purge.push(item.id)
      continue
    }
    kept.push({ id: item.id, reason: d.reason, dueAt: d.dueAt })
    if (d.reason === 'not_due' && d.dueAt && (nextDueAt === null || d.dueAt < nextDueAt)) nextDueAt = d.dueAt
  }
  return { purge, kept, nextDueAt, auditCheckpoint: checkpoint }
}
