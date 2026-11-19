// The evidence snapshot blob: what intake writes to object storage at `apps/{app_id}/{report_id}`
// once a report is accepted, and what other modules read. JSON, UTF-8. Bump the format when the
// layout changes; readers refuse a format they do not know.

export const REPORT_SNAPSHOT_FORMAT = 'flagwise.report.v1'

/** A party as stored: dates are ISO 8601 strings. */
export interface SnapshotParty {
  readonly externalId: string
  readonly accountCreatedAt?: string
  readonly email?: string
  readonly locale?: 'en' | 'id'
}

export interface SnapshotContentItem {
  readonly text: string
  readonly author?: string
  readonly at?: string
}

/** The checked report as intake accepted it. */
export interface SnapshotReport {
  readonly reporter: SnapshotParty
  readonly reported: SnapshotParty
  readonly category: string
  readonly text?: string
  readonly evidence: {
    readonly kind: string
    readonly content: readonly SnapshotContentItem[]
    readonly media: readonly string[]
    readonly authorId?: string
    readonly metadata: Readonly<Record<string, string | number | boolean>>
  }
  readonly identifiers: {
    readonly phoneHash?: string
    readonly emailHash?: string
    readonly deviceHash?: string
  }
}

export interface ReportSnapshot {
  readonly format: typeof REPORT_SNAPSHOT_FORMAT
  readonly report_id: string
  readonly received_at: string
  readonly report: SnapshotReport
}

/**
 * Reads a snapshot blob. Throws a TypeError when the bytes are not JSON, the format is not
 * REPORT_SNAPSHOT_FORMAT, or the parts readers rely on are missing: report_id, received_at,
 * report.reporter.externalId, report.reported.externalId, report.category, report.evidence.kind
 * and report.evidence.content as an array of items with a string text. The rest is trusted as
 * intake wrote it.
 */
export function parseReportSnapshot(bytes: Uint8Array): ReportSnapshot {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new TypeError('Report snapshot is not JSON')
  }
  const o = value as Record<string, any> | null
  if (typeof o !== 'object' || o === null) throw new TypeError('Report snapshot is not an object')
  if (o.format !== REPORT_SNAPSHOT_FORMAT) throw new TypeError(`Unknown report snapshot format: ${String(o.format)}`)
  const r = o.report
  const ok =
    typeof o.report_id === 'string' &&
    typeof o.received_at === 'string' &&
    typeof r?.reporter?.externalId === 'string' &&
    typeof r?.reported?.externalId === 'string' &&
    typeof r?.category === 'string' &&
    typeof r?.evidence?.kind === 'string' &&
    Array.isArray(r?.evidence?.content) &&
    r.evidence.content.every((item: any) => typeof item?.text === 'string')
  if (!ok) throw new TypeError('Report snapshot is missing required fields')
  return o as ReportSnapshot
}
