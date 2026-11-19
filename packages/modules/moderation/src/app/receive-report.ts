// A received report joins the account's open case or opens a new one.

import type { TenantRef } from '@flagwise/kernel'
import { ACCEPTS_REPORTS, acceptsNewReports } from '../domain/case-state.ts'
import { CaseChangedError, type CaseRecord, type ModerationDeps, type ReportFacts, type SeverityBand } from './ports.ts'

export interface ReportReceived {
  readonly tenant: TenantRef
  readonly reportId: string
  readonly subjectExternalId: string
  /** Pre-rules or the reporter's picked category carry a P0 signal. */
  readonly p0Signal: boolean
  /** What the report said about the accounts; left out on reports from before they were carried. */
  readonly facts?: ReportFacts
}

export interface ReceiveReportResult {
  readonly caseId: string
  readonly joinedExistingCase: boolean
  readonly duplicate: boolean
}

/**
 * Attaches the report to the account's open case, or opens a new case.
 *
 * 0. Lock. `lockSubject(report.tenant, report.subjectExternalId)` first, so reports about one
 *    account are handled one at a time and "one case per subject and band" holds without relying
 *    on event order.
 * 1. Duplicate delivery. Events arrive at least once, so the same report may come twice. If
 *    `findByReportId(report.tenant, report.reportId)` finds a case, return `{ caseId,
 *    joinedExistingCase: (the report is not that case's first report), duplicate: true }` and write
 *    and publish nothing.
 * 2. Band. The report's band is 'p0' when `report.p0Signal` is true, otherwise 'standard'.
 * 3. Join. Among `findBySubject(report.tenant, report.subjectExternalId)`, the candidates are cases
 *    whose state accepts new reports and whose band equals the report's band; when several, the
 *    one with the earliest `openedAt`. `attachReport` it there, allowed only while the case still
 *    accepts reports; publish `case.report_attached` with `occurredAt: now`; return
 *    `{ caseId, joinedExistingCase: true, duplicate: false }`.
 * 4. Open. With no candidate, insert a new case: id `deps.newCaseId()`, the report's tenant and
 *    subject, the band, state 'classifying', `reportIds: [reportId]`, `openedAt: now`. Publish
 *    `case.opened` (`occurredAt` = `openedAt`) and return
 *    `{ caseId, joinedExistingCase: false, duplicate: false }`.
 *    In steps 3 and 4, when the report has `facts`, the event carries them for triage; moderation
 *    keeps none.
 * 5. Concurrency. If attachReport returns false (the case stopped accepting reports meanwhile),
 *    start again from step 1 with fresh reads; at most 3 attempts in total, then throw
 *    CaseChangedError. Any error is thrown right away.
 *
 * Events are published only after the write succeeded, exactly one per call that is not a
 * duplicate. Records read from the repository are never mutated.
 */
export async function receiveReport(deps: ModerationDeps, report: ReportReceived): Promise<ReceiveReportResult> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await receiveOnce(deps, report)
    if (result) return result
  }
  throw new CaseChangedError(`for report ${report.reportId}`)
}

/** The result, or null when the chosen case stopped accepting reports before the report joined. */
async function receiveOnce(deps: ModerationDeps, report: ReportReceived): Promise<ReceiveReportResult | null> {
  const { tenant, reportId } = report
  await deps.cases.lockSubject(tenant, report.subjectExternalId)

  const duplicateOf = await deps.cases.findByReportId(tenant, reportId)
  if (duplicateOf) {
    return { caseId: duplicateOf.id, joinedExistingCase: duplicateOf.reportIds[0] !== reportId, duplicate: true }
  }

  const band: SeverityBand = report.p0Signal ? 'p0' : 'standard'
  const now = deps.clock.now()

  const candidates = (await deps.cases.findBySubject(tenant, report.subjectExternalId)).filter(
    (c) => acceptsNewReports(c.state) && c.band === band,
  )
  const target = candidates.reduce<CaseRecord | undefined>(
    (best, c) => (best === undefined || c.openedAt.getTime() < best.openedAt.getTime() ? c : best),
    undefined,
  )

  if (target) {
    if (!(await deps.cases.attachReport(tenant, target.id, reportId, ACCEPTS_REPORTS))) return null
    await deps.events.publish({ type: 'case.report_attached', tenant, caseId: target.id, reportId, ...(report.facts && { facts: report.facts }), occurredAt: now })
    return { caseId: target.id, joinedExistingCase: true, duplicate: false }
  }

  const opened: CaseRecord = {
    id: deps.newCaseId(),
    tenant,
    subjectExternalId: report.subjectExternalId,
    band,
    state: 'classifying',
    reportIds: [reportId],
    openedAt: now,
  }
  await deps.cases.insert(opened)
  await deps.events.publish({
    type: 'case.opened',
    tenant,
    caseId: opened.id,
    reportId,
    subjectExternalId: opened.subjectExternalId,
    band,
    ...(report.facts && { facts: report.facts }),
    occurredAt: opened.openedAt,
  })
  return { caseId: opened.id, joinedExistingCase: false, duplicate: false }
}
