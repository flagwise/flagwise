// The audit log of each app and mode: one hash chain, appended to from the event bus, searched and
// verified through the API.

import type { Clock, TenantRef } from '@flagwise/kernel'
import { appendEntry, verifyChain, type AuditEntry, type ChainProblem } from '../domain/chain.ts'
import { auditRecordOf, type RecordedEvent } from '../domain/events.ts'

export interface AuditQuery {
  readonly actorId?: string
  readonly caseId?: string
  readonly subjectExternalId?: string
  /** Entries at or after this time. */
  readonly from?: Date
  /** Entries before this time. */
  readonly to?: Date
  readonly limit: number
  /** Entries after this seq. */
  readonly afterSeq?: number
}

export interface AuditPage {
  readonly data: readonly AuditEntry[]
  /** The seq to continue after, or null on the last page. */
  readonly nextAfterSeq: number | null
}

/** One app and mode's chain, inside one tenant transaction. */
export interface AuditStore {
  /**
   * Holds the chain for the rest of the transaction, so entries are appended one at a time, and
   * returns its last entry (null when empty) and whether `sourceEventId` is recorded already.
   */
  lockChain(tenant: TenantRef, sourceEventId: string): Promise<{ readonly last: AuditEntry | null; readonly recorded: boolean }>
  insert(tenant: TenantRef, entry: AuditEntry, found: { readonly sourceEventId: string; readonly caseId: string | null; readonly subjectExternalId: string | null }): Promise<void>
  /** Matching entries in seq order. */
  search(tenant: TenantRef, query: AuditQuery): Promise<AuditPage>
  /** Entries after `afterSeq` in seq order, at most `limit`. */
  entriesAfter(tenant: TenantRef, afterSeq: number, limit: number): Promise<readonly AuditEntry[]>
  /** The last purged entry's seq and hash, once retention has purged any. */
  checkpoint(tenant: TenantRef): Promise<{ readonly seq: number; readonly hash: string } | null>
}

export interface AuditDeps {
  readonly store: AuditStore
  readonly clock: Clock
}

/**
 * Appends the entry for an event to its app and mode's chain and returns it. Null, writing nothing,
 * for a type the log does not record or an event already recorded (a redelivery).
 */
export async function recordEvent(deps: AuditDeps, tenant: TenantRef, event: RecordedEvent): Promise<AuditEntry | null> {
  const record = auditRecordOf(event, deps.clock.now())
  if (!record) return null
  const { last, recorded } = await deps.store.lockChain(tenant, event.id)
  if (recorded) return null
  const entry = appendEntry(last, record.input)
  await deps.store.insert(tenant, entry, { sourceEventId: event.id, caseId: record.caseId, subjectExternalId: record.subjectExternalId })
  return entry
}

export type AuditVerification =
  | { readonly ok: true; readonly checked: number }
  | { readonly ok: false; readonly checked: number; readonly seq: number; readonly reason: ChainProblem }

const VERIFY_PAGE = 1_000

/**
 * Verifies the whole chain from its checkpoint (or its start), a page at a time; reports the first
 * broken entry, and how many entries were checked up to it.
 */
export async function verifyAuditLog(deps: Pick<AuditDeps, 'store'>, tenant: TenantRef): Promise<AuditVerification> {
  let from = (await deps.store.checkpoint(tenant)) ?? undefined
  let checked = 0
  for (;;) {
    const page = await deps.store.entriesAfter(tenant, from?.seq ?? 0, VERIFY_PAGE)
    if (page.length === 0) return { ok: true, checked }
    const result = verifyChain(page, from)
    if (!result.ok) return { ok: false, checked: checked + page.findIndex((e) => e.seq === result.seq), seq: result.seq, reason: result.reason }
    checked += page.length
    const last = page[page.length - 1]!
    from = { seq: last.seq, hash: last.hash }
  }
}
