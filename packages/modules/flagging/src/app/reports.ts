// Accepting reports: check the body, keep the evidence snapshot in object storage, store the report
// and publish report.received in one tenant transaction. Which case a report belongs to is decided
// later by the cases module; flagging only records the answer when the case event arrives.

import { createHash } from 'node:crypto'
import { FlagwiseError, type Clock, type TenantRef } from '@flagwise/kernel'
import type { ObjectStorage } from '@flagwise/platform'
import { parseReportSnapshot, REPORT_SNAPSHOT_FORMAT, type P0Signal, type ReportSnapshot } from '@flagwise/contracts'
import { preRules, reportTexts } from '../domain/pre-rules.ts'
import { MAX_REPORT_BYTES, validateReport, type ReportInput } from '../domain/validate-report.ts'

export interface Report {
  readonly id: string
  readonly tenant: TenantRef
  readonly reporterExternalId: string
  readonly reportedExternalId: string
  readonly category: string
  /** Where the evidence snapshot is in object storage: `apps/{app_id}/{report_id}`. */
  readonly snapshotKey: string
  readonly idempotencyKey: string | null
  /** SHA-256 (hex) of the request body, to tell a replay from a reused idempotency key. */
  readonly requestHash: string
  readonly receivedAt: Date
  /** Set once the cases module has put the report in a case. */
  readonly caseId: string | null
  readonly joinedExistingCase: boolean | null
  /** When its reporter or reported account was erased (its evidence is gone); unset or null before. */
  readonly erasedAt?: Date | null
}

/** Report access inside one tenant transaction. */
export interface ReportStore {
  findById(tenant: TenantRef, reportId: string): Promise<Report | null>
  /** The report that holds this idempotency key, if it was received at or after `since`. */
  findByIdempotencyKey(tenant: TenantRef, key: string, since: Date): Promise<Report | null>
  /**
   * Inserts the report. Its idempotency key is first taken from reports received before `since`,
   * whose keys have expired. False, writing nothing, when a report received at or after `since`
   * still holds the key; a concurrent insert with the same key waits for the other to finish.
   */
  insert(report: Report, since: Date): Promise<boolean>
  /** Records the report's case, only while it has none; true when it changed. */
  setCase(tenant: TenantRef, reportId: string, caseId: string, joinedExistingCase: boolean): Promise<boolean>
  /** The reports the account filed or was reported in. */
  reportsOf(tenant: TenantRef, externalId: string): Promise<readonly Report[]>
  /** Replaces the account's id with `erasedId` in its reports and marks them erased at `at`; how many it changed. */
  eraseAccount(tenant: TenantRef, externalId: string, erasedId: string, at: Date): Promise<number>
}

export interface ReportReceivedEvent {
  readonly id: string
  readonly type: 'report.received.v1'
  readonly key: string
  readonly data: {
    readonly reportId: string
    readonly subjectExternalId: string
    /** The pre-rules found a P0 signal. */
    readonly p0Signal: boolean
    /** The P0 signals the pre-rules found, in P0_SIGNALS order. */
    readonly p0Signals: readonly P0Signal[]
    /** The pre-rules found text that tries to steer the classifier. */
    readonly injectionSuspected: boolean
    /** What the report says about the accounts; account times in RFC 3339, null when not given. */
    readonly facts: {
      readonly reporterExternalId: string
      readonly reporterAccountCreatedAt: string | null
      readonly reportedAccountCreatedAt: string | null
    }
  }
}

export interface FlaggingTx {
  readonly reports: ReportStore
  /** Publishes in the transaction, so the event exists exactly when the report does. */
  publish(event: ReportReceivedEvent | { readonly id: string; readonly type: string; readonly key: string; readonly data: unknown }): Promise<void>
}

export interface FlaggingDeps {
  /** Runs `fn` in one transaction for the tenant; a run that throws writes nothing. */
  run<R>(tenant: TenantRef, fn: (tx: FlaggingTx) => Promise<R>): Promise<R>
  readonly storage: ObjectStorage
  readonly clock: Clock
  readonly newReportId: () => string
}

export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/

/** The evidence snapshot format (contracts' REPORT_SNAPSHOT_FORMAT). */
export const SNAPSHOT_FORMAT = REPORT_SNAPSHOT_FORMAT

export interface SubmitInput {
  readonly tenant: TenantRef
  /** The raw request body. */
  readonly body: string
  readonly idempotencyKey?: string | undefined
}

export interface SubmitResult {
  readonly report: Report
  /** True when an earlier request with the same idempotency key and body already stored it. */
  readonly replayed: boolean
}

/**
 * Accepts a report.
 *
 * 1. Check. An idempotency key must be 1 to 255 visible ASCII characters ('invalid_request'). A
 *    body over 64 KB is 'payload_too_large', a body that is not JSON 'invalid_request', and one
 *    that breaks the report schema 'validation_failed' with every field error (validateReport).
 * 2. Replay. With an idempotency key held by a report received in the last 24 hours: the same body
 *    returns that report with `replayed: true` and writes nothing; another body is 'conflict'.
 * 3. Snapshot. The checked report is written to `apps/{app_id}/{report_id}` as JSON
 *    `{ format, report_id, received_at, report }` before the database, so a stored report always
 *    has its snapshot. A failed transaction or a lost race leaves an unused snapshot behind.
 * 4. Store. In one transaction: insert the report (case unknown) and publish report.received
 *    (id `report.received:{report_id}`, key the report id) for the reported account, with
 *    `p0Signal` true when classify's pre-rules find a P0 signal in the picked category, the text or
 *    the evidence messages, and `facts`: the reporter's id and both accounts' `account_created_at`
 *    (ISO, null when not given). When a concurrent request took the key first, step 2 decides
 *    instead.
 */
export async function submitReport(deps: FlaggingDeps, input: SubmitInput): Promise<SubmitResult> {
  const { tenant, idempotencyKey } = input
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new FlagwiseError('invalid_request', 'Idempotency-Key must be 1 to 255 visible ASCII characters')
  }
  const value = parseReport(input.body)
  const requestHash = createHash('sha256').update(input.body).digest('hex')
  const now = deps.clock.now()
  const since = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS)

  const replay = (earlier: Report): SubmitResult => {
    if (earlier.requestHash !== requestHash) throw new FlagwiseError('conflict', 'Idempotency-Key was already used with a different request')
    return { report: earlier, replayed: true }
  }

  if (idempotencyKey !== undefined) {
    const earlier = await deps.run(tenant, (tx) => tx.reports.findByIdempotencyKey(tenant, idempotencyKey, since))
    if (earlier) return replay(earlier)
  }

  const id = deps.newReportId()
  const report: Report = {
    id,
    tenant,
    reporterExternalId: value.reporter.externalId,
    reportedExternalId: value.reported.externalId,
    category: value.category,
    snapshotKey: `apps/${tenant.appId}/${id}`,
    idempotencyKey: idempotencyKey ?? null,
    requestHash,
    receivedAt: now,
    caseId: null,
    joinedExistingCase: null,
  }
  const snapshot = { format: SNAPSHOT_FORMAT, report_id: id, received_at: now.toISOString(), report: value }
  const screened = preRules(reportTexts(value))
  await deps.storage.put(report.snapshotKey, new TextEncoder().encode(JSON.stringify(snapshot)), 'application/json')

  return deps.run(tenant, async (tx) => {
    if (!(await tx.reports.insert(report, since))) {
      const holder = await tx.reports.findByIdempotencyKey(tenant, idempotencyKey!, since)
      if (!holder) throw new Error(`Report ${id} was not stored and no report holds its idempotency key`)
      return replay(holder)
    }
    await tx.publish({
      id: `report.received:${id}`,
      type: 'report.received.v1',
      key: id,
      data: {
        reportId: id,
        subjectExternalId: report.reportedExternalId,
        p0Signal: screened.p0Signals.length > 0,
        p0Signals: screened.p0Signals,
        injectionSuspected: screened.injectionSuspected,
        facts: {
          reporterExternalId: report.reporterExternalId,
          reporterAccountCreatedAt: value.reporter.accountCreatedAt?.toISOString() ?? null,
          reportedAccountCreatedAt: value.reported.accountCreatedAt?.toISOString() ?? null,
        },
      },
    })
    return { report, replayed: false }
  })
}

function parseReport(body: string): ReportInput {
  const byteLength = new TextEncoder().encode(body).length
  let parsed: unknown
  if (byteLength <= MAX_REPORT_BYTES) {
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new FlagwiseError('invalid_request', 'The body is not valid JSON')
    }
  }
  const result = validateReport(parsed, byteLength)
  if (result.ok) return result.value
  if (result.status === 413) throw new FlagwiseError('payload_too_large', 'Payload exceeds 64 KB', { errors: result.errors })
  throw new FlagwiseError('validation_failed', 'See errors for each invalid field', { errors: result.errors })
}

/** The report, or 'not_found' when the tenant has no report with this id. */
export async function getReport(deps: Pick<FlaggingDeps, 'run'>, tenant: TenantRef, reportId: string): Promise<Report> {
  const report = await deps.run(tenant, (tx) => tx.reports.findById(tenant, reportId))
  if (!report) throw new FlagwiseError('not_found', `No report ${reportId}`)
  return report
}

/**
 * What the report says, from its evidence snapshot: 'not_found' when the tenant has no report with
 * this id; 'gone' once its reporter or reported account was erased; an Error when its snapshot is missing or unreadable, which is a broken install, not a
 * client mistake.
 */
export async function getEvidence(deps: Pick<FlaggingDeps, 'run' | 'storage'>, tenant: TenantRef, reportId: string): Promise<ReportSnapshot> {
  const report = await getReport(deps, tenant, reportId)
  if (report.erasedAt) throw new FlagwiseError('gone', `The evidence of report ${reportId} was erased with its account`)
  const bytes = await deps.storage.get(report.snapshotKey)
  if (!bytes) throw new Error(`The evidence snapshot of report ${reportId} is missing`)
  return parseReportSnapshot(bytes)
}

/**
 * Records which case the report is in, from case.opened (`joinedExistingCase: false`) or
 * case.report_attached (true). Only the first answer counts; a report flagging does not know is
 * left alone. Returns whether it changed anything.
 */
export async function recordReportCase(
  deps: Pick<FlaggingDeps, 'run'>,
  input: { readonly tenant: TenantRef; readonly reportId: string; readonly caseId: string; readonly joinedExistingCase: boolean },
): Promise<boolean> {
  return deps.run(input.tenant, (tx) => tx.reports.setCase(input.tenant, input.reportId, input.caseId, input.joinedExistingCase))
}

/**
 * Erases an account's part of flagging: deletes the evidence snapshot of every report it filed or was
 * reported in (deleting a missing one is fine, so a redelivery can finish the job), then replaces
 * its id with `erasedId` in those reports and marks them erased. Returns how many reports it had.
 */
export async function eraseAccount(
  deps: Pick<FlaggingDeps, 'storage' | 'clock'>,
  tx: FlaggingTx,
  tenant: TenantRef,
  externalId: string,
  erasedId: string,
): Promise<number> {
  const reports = await tx.reports.reportsOf(tenant, externalId)
  for (const r of reports) await deps.storage.delete(r.snapshotKey)
  await tx.reports.eraseAccount(tenant, externalId, erasedId, deps.clock.now())
  return reports.length
}
