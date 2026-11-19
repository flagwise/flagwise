// The CaseRepository on Postgres. It works inside a tenant transaction, so row-level security limits
// it to that tenant; every query also filters by the tenant it is given.

import type { TenantRef } from '@flagwise/kernel'
import { loadMigrations, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { CaseState } from '../domain/case-state.ts'
import { QUEUE_STATES, type CaseChange, type CaseOrder, type CaseReader, type CaseRecord, type CaseRepository, type Decision, type Severity, type SeverityBand } from '../app/ports.ts'
import { actionFailuresTable, caseReportsTable, casesTable, decisionsTable } from './schema.ts'

// Internal ids keep the service's first name: the migration set, the schema and the consumer groups are 'cases'.
export const moderationMigrations: MigrationSet = loadMigrations('cases', new URL('./migrations/', import.meta.url))

type CaseRow = typeof casesTable.$inferSelect
type DecisionRow = typeof decisionsTable.$inferSelect

/**
 * A CaseRepository on the given tenant transaction.
 *
 * Records read back equal the records written, with `claim`, `triage` and `decision` as null when
 * absent, and a decision's `publicReason` / `internalNote` left out when absent. `reportIds` keep
 * their order. `change` is one UPDATE whose WHERE clause is the condition, so the check and the
 * write cannot be split by another writer; a decision, once saved, is not changed again.
 * `attachReport` locks the case row for share while it checks the state and inserts the report, so
 * a state change waits for it (or it sees the new state). A report id can belong to only one case
 * of a tenant: attaching it to a second case fails. `classification` is left out of a record
 * until it is set.
 *
 * `list` is one query ordered by an urgency key (minus the priority, untriaged last; the SLA due
 * time, none last; the id), or for 'recent' by opened time and id, both descending; the cursor is
 * that key of the page's last case, tagged with its order, so a page never repeats or skips a case
 * that did not change in between. A triage's `applied` and `flags` are left out when not stored.
 */
export function pgCaseRepository(tx: TenantTx): CaseRepository & CaseReader {
  const tenantOf = (t: TenantRef) =>
    and(eq(casesTable.orgId, t.orgId), eq(casesTable.appId, t.appId), eq(casesTable.livemode, t.livemode))

  const load = async (tenant: TenantRef, rows: CaseRow[]): Promise<CaseRecord[]> => {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const reports = await tx
      .select()
      .from(caseReportsTable)
      .where(
        and(
          eq(caseReportsTable.orgId, tenant.orgId),
          eq(caseReportsTable.appId, tenant.appId),
          eq(caseReportsTable.livemode, tenant.livemode),
          inArray(caseReportsTable.caseId, ids),
        ),
      )
      .orderBy(asc(caseReportsTable.position))
    const decisionIds = rows.flatMap((r) => (r.decisionId ? [r.decisionId] : []))
    const decisions = decisionIds.length
      ? await tx
          .select()
          .from(decisionsTable)
          .where(and(eq(decisionsTable.orgId, tenant.orgId), eq(decisionsTable.appId, tenant.appId), inArray(decisionsTable.id, decisionIds)))
      : []
    const byId = new Map(decisions.map((d) => [d.id, d]))
    return rows.map((row) => toRecord(row, reports.filter((r) => r.caseId === row.id).map((r) => r.reportId), row.decisionId ? byId.get(row.decisionId) : undefined))
  }

  const insertReports = async (tenant: TenantRef, caseId: string, reportIds: readonly string[], from: number) => {
    const rows = reportIds.map((reportId, i) => ({ ...tenantColumns(tenant), reportId, caseId, position: from + i }))
    if (rows.length) await tx.insert(caseReportsTable).values(rows)
  }

  const insertDecision = async (tenant: TenantRef, caseId: string, d: Decision) => {
    await tx
      .insert(decisionsTable)
      .values({
        ...tenantColumns(tenant),
        id: d.id,
        caseId,
        outcome: d.outcome,
        categoryId: d.categoryId,
        severity: d.severity,
        actionKeys: [...d.actionKeys],
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt,
        reportIds: [...d.reportIds],
        publicReason: d.publicReason ?? null,
        internalNote: d.internalNote ?? null,
      })
      .onConflictDoNothing()
  }

  const repo: CaseRepository & CaseReader = {
    async list(tenant, query) {
      const limit = query.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be 1 to 100')
      const where: (SQL | undefined)[] = [tenantOf(tenant), inArray(casesTable.state, [...(query.states ?? QUEUE_STATES)])]
      if (query.severities) where.push(inArray(casesTable.triageSeverity, [...query.severities]))
      if (query.categoryIds) where.push(inArray(casesTable.categoryId, [...query.categoryIds]))
      if (query.claimedBy === null) where.push(isNull(casesTable.claimMemberId))
      else if (query.claimedBy !== undefined) where.push(eq(casesTable.claimMemberId, query.claimedBy))
      if (query.slaBreached === true) where.push(and(isNotNull(casesTable.triageSlaDueAt), lte(casesTable.triageSlaDueAt, query.now)))
      if (query.slaBreached === false) where.push(or(isNull(casesTable.triageSlaDueAt), gt(casesTable.triageSlaDueAt, query.now)))
      if (query.subjectExternalId !== undefined) where.push(eq(casesTable.subjectExternalId, query.subjectExternalId))
      const order = query.order ?? 'urgency'
      if (query.cursor !== undefined) {
        const key = decodeCursor(query.cursor, order)
        where.push(
          key.order === 'urgency'
            ? sql`(${URGENCY_PRIORITY}, ${URGENCY_DUE}, ${casesTable.id}) > (${key.priority}::int, ${key.due}::timestamptz, ${key.id})`
            : sql`(${casesTable.openedAt}, ${casesTable.id}) < (${key.openedAt}::timestamptz, ${key.id})`,
        )
      }
      const rows = await tx
        .select()
        .from(casesTable)
        .where(and(...where))
        .orderBy(...(order === 'urgency' ? [URGENCY_PRIORITY, URGENCY_DUE, asc(casesTable.id)] : [desc(casesTable.openedAt), desc(casesTable.id)]))
        .limit(limit + 1)
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        data: await load(tenant, page),
        nextCursor: rows.length > limit && last ? encodeCursor(last, order) : null,
      }
    },

    async findById(tenant, caseId) {
      const rows = await tx.select().from(casesTable).where(and(tenantOf(tenant), eq(casesTable.id, caseId)))
      return (await load(tenant, rows))[0] ?? null
    },

    async findBySubject(tenant, subjectExternalId) {
      const rows = await tx
        .select()
        .from(casesTable)
        .where(and(tenantOf(tenant), eq(casesTable.subjectExternalId, subjectExternalId)))
        .orderBy(asc(casesTable.openedAt), asc(casesTable.id))
      return load(tenant, rows)
    },

    async findByReportId(tenant, reportId) {
      const [hit] = await tx
        .select({ caseId: caseReportsTable.caseId })
        .from(caseReportsTable)
        .where(
          and(
            eq(caseReportsTable.orgId, tenant.orgId),
            eq(caseReportsTable.appId, tenant.appId),
            eq(caseReportsTable.livemode, tenant.livemode),
            eq(caseReportsTable.reportId, reportId),
          ),
        )
      return hit ? repo.findById(tenant, hit.caseId) : null
    },

    async lockSubject(tenant, subjectExternalId) {
      // A transaction-scoped advisory lock: released at commit or rollback. A hash collision
      // only makes two unrelated subjects wait for each other.
      const key = JSON.stringify([tenant.orgId, tenant.appId, tenant.livemode, subjectExternalId])
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cases.subject:${key}`}, 0))`)
    },

    async insert(record) {
      await tx.insert(casesTable).values({
        ...tenantColumns(record.tenant),
        id: record.id,
        subjectExternalId: record.subjectExternalId,
        band: record.band,
        openedAt: record.openedAt,
        ...changeColumns({
          claim: record.claim ?? null,
          ...(record.triage && { triage: record.triage }),
          ...(record.classification && { classification: record.classification }),
          ...(record.decision && { decision: record.decision }),
        }),
        state: record.state,
      })
      await insertReports(record.tenant, record.id, record.reportIds, 0)
      if (record.decision) await insertDecision(record.tenant, record.id, record.decision)
    },

    async change(tenant, caseId, condition, change) {
      const set = changeColumns(change)
      if (Object.keys(set).length === 0) throw new TypeError('A case change needs at least one field')
      const where: (SQL | undefined)[] = [tenantOf(tenant), eq(casesTable.id, caseId), inArray(casesTable.state, [...condition.states])]
      if (condition.claimedBy === null) where.push(isNull(casesTable.claimMemberId))
      else if (condition.claimedBy !== undefined) where.push(eq(casesTable.claimMemberId, condition.claimedBy))
      if (condition.claimIdleSince) where.push(lte(casesTable.claimLastActivityAt, condition.claimIdleSince))
      if (condition.decisionId !== undefined) where.push(eq(casesTable.decisionId, condition.decisionId))
      const changed = await tx.update(casesTable).set(set).where(and(...where)).returning({ id: casesTable.id })
      if (changed.length === 0) return false
      // The decision id is set above; its foreign key is checked at commit, after this insert.
      if (change.decision) await insertDecision(tenant, caseId, change.decision)
      return true
    },

    async attachReport(tenant, caseId, reportId, states) {
      const open = await tx
        .select({ id: casesTable.id })
        .from(casesTable)
        .where(and(tenantOf(tenant), eq(casesTable.id, caseId), inArray(casesTable.state, [...states])))
        .for('share')
      if (open.length === 0) return false
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(caseReportsTable)
        .where(and(eq(caseReportsTable.orgId, tenant.orgId), eq(caseReportsTable.appId, tenant.appId), eq(caseReportsTable.caseId, caseId)))
      await insertReports(tenant, caseId, [reportId], n)
      return true
    },

    async eraseAccount(tenant, externalId, erasedId) {
      const cases = await tx
        .update(casesTable)
        .set({ subjectExternalId: erasedId })
        .where(and(tenantOf(tenant), eq(casesTable.subjectExternalId, externalId)))
        .returning({ id: casesTable.id })
      const ids = cases.map((c) => c.id)
      if (ids.length > 0) {
        await tx
          .update(decisionsTable)
          .set({ publicReason: null, internalNote: null })
          .where(and(eq(decisionsTable.orgId, tenant.orgId), eq(decisionsTable.appId, tenant.appId), eq(decisionsTable.livemode, tenant.livemode), inArray(decisionsTable.caseId, ids)))
      }
      const reports = await tx
        .update(caseReportsTable)
        .set({ reporterExternalId: null, reporterAccountCreatedAt: null, reportedAccountCreatedAt: null })
        .where(
          and(
            reportsOf(tenant),
            isNotNull(caseReportsTable.reporterExternalId),
            ids.length > 0 ? or(eq(caseReportsTable.reporterExternalId, externalId), inArray(caseReportsTable.caseId, ids)) : eq(caseReportsTable.reporterExternalId, externalId),
          ),
        )
        .returning({ id: caseReportsTable.reportId })
      return ids.length + reports.length
    },

    async addActionFailure(tenant, caseId, actionRequestId, at) {
      const rows = await tx
        .insert(actionFailuresTable)
        .values({ ...tenantColumns(tenant), caseId, actionRequestId, failedAt: at })
        .onConflictDoNothing()
        .returning({ id: actionFailuresTable.actionRequestId })
      return rows.length > 0
    },

    async openActionFailures(tenant, caseId) {
      const f = actionFailuresTable
      const rows = await tx
        .select({ id: f.actionRequestId })
        .from(f)
        .where(and(eq(f.orgId, tenant.orgId), eq(f.appId, tenant.appId), eq(f.livemode, tenant.livemode), eq(f.caseId, caseId), eq(f.answered, false)))
        .orderBy(asc(f.failedAt), asc(f.actionRequestId))
      return rows.map((r) => r.id)
    },

    async answerActionFailures(tenant, caseId, actionRequestIds) {
      if (actionRequestIds.length === 0) return
      const f = actionFailuresTable
      await tx
        .update(f)
        .set({ answered: true })
        .where(and(eq(f.orgId, tenant.orgId), eq(f.appId, tenant.appId), eq(f.livemode, tenant.livemode), eq(f.caseId, caseId), inArray(f.actionRequestId, [...actionRequestIds])))
    },
  }
  return repo
}

const tenantColumns = (t: TenantRef) => ({ orgId: t.orgId, appId: t.appId, livemode: t.livemode })

const reportsOf = (t: TenantRef) =>
  and(eq(caseReportsTable.orgId, t.orgId), eq(caseReportsTable.appId, t.appId), eq(caseReportsTable.livemode, t.livemode))

/** The columns a change sets; fields not in the change are left out. */
function changeColumns(c: CaseChange) {
  return {
    ...(c.state !== undefined && { state: c.state }),
    ...(c.claim !== undefined && {
      claimMemberId: c.claim?.memberId ?? null,
      claimedAt: c.claim?.claimedAt ?? null,
      claimLastActivityAt: c.claim?.lastActivityAt ?? null,
    }),
    ...(c.triage !== undefined && {
      triageSeverity: c.triage.severity,
      triagePriority: c.triage.priority,
      triageSlaDueAt: c.triage.slaDueAt,
      triageSuggestedActionKeys: [...c.triage.suggestedActionKeys],
      triageApplied: c.triage.applied ? [...c.triage.applied] : null,
      triageFlags: c.triage.applied ? [...(c.triage.flags ?? [])] : null,
    }),
    ...(c.classification !== undefined && {
      categoryId: c.classification.categoryId,
      signals: [...c.classification.signals],
      injectionSuspected: c.classification.injectionSuspected,
      classifiedBy: c.classification.classifiedBy,
      customCategoryId: c.classification.customCategoryId ?? null,
    }),
    ...(c.decision !== undefined && { decisionId: c.decision.id }),
  }
}

// The queue's sort key, all ascending: higher priority first, untriaged cases (no priority) last;
// sooner SLA first, none last.
const URGENCY_PRIORITY = sql`(-coalesce(${casesTable.triagePriority}, -1))`
const URGENCY_DUE = sql`coalesce(${casesTable.triageSlaDueAt}, 'infinity'::timestamptz)`

type CursorKey =
  | { readonly order: 'urgency'; readonly priority: number; readonly due: string; readonly id: string }
  | { readonly order: 'recent'; readonly openedAt: string; readonly id: string }

// Urgency cursors are [priority, due, id], as before 'recent' existed; recent ones ['r', openedAt, id].
function encodeCursor(row: CaseRow, order: CaseOrder): string {
  const key =
    order === 'urgency'
      ? [-(row.triagePriority ?? -1), row.triageSlaDueAt ? row.triageSlaDueAt.toISOString() : 'infinity', row.id]
      : ['r', row.openedAt.toISOString(), row.id]
  return Buffer.from(JSON.stringify(key)).toString('base64url')
}

function decodeCursor(cursor: string, order: CaseOrder): CursorKey {
  let key: unknown
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new RangeError('Not a valid cursor')
  }
  if (!Array.isArray(key) || key.length !== 3 || typeof key[1] !== 'string' || typeof key[2] !== 'string') throw new RangeError('Not a valid cursor')
  if (order === 'urgency' && Number.isInteger(key[0]) && (key[1] === 'infinity' || !Number.isNaN(Date.parse(key[1])))) {
    return { order, priority: key[0] as number, due: key[1], id: key[2] }
  }
  if (order === 'recent' && key[0] === 'r' && !Number.isNaN(Date.parse(key[1]))) return { order, openedAt: key[1], id: key[2] }
  throw new RangeError('Not a valid cursor')
}

function toRecord(row: CaseRow, reportIds: string[], decision: DecisionRow | undefined): CaseRecord {
  return {
    id: row.id,
    tenant: { orgId: row.orgId, appId: row.appId, livemode: row.livemode },
    subjectExternalId: row.subjectExternalId,
    band: row.band as SeverityBand,
    state: row.state as CaseState,
    reportIds,
    openedAt: row.openedAt,
    claim:
      row.claimMemberId && row.claimedAt && row.claimLastActivityAt
        ? { memberId: row.claimMemberId, claimedAt: row.claimedAt, lastActivityAt: row.claimLastActivityAt }
        : null,
    triage:
      row.triageSeverity && row.triagePriority !== null && row.triageSlaDueAt && row.triageSuggestedActionKeys
        ? {
            severity: row.triageSeverity as Severity,
            priority: row.triagePriority,
            slaDueAt: row.triageSlaDueAt,
            suggestedActionKeys: row.triageSuggestedActionKeys,
            ...(row.triageApplied !== null && { applied: row.triageApplied, flags: row.triageFlags ?? [] }),
          }
        : null,
    decision: decision ? toDecision(decision) : null,
    ...(row.categoryId !== null &&
      row.signals !== null &&
      row.injectionSuspected !== null &&
      row.classifiedBy !== null && {
        classification: {
          categoryId: row.categoryId,
          signals: row.signals,
          injectionSuspected: row.injectionSuspected,
          classifiedBy: row.classifiedBy as 'llm' | 'rules',
          ...(row.customCategoryId !== null && { customCategoryId: row.customCategoryId }),
        },
      }),
  }
}

function toDecision(d: DecisionRow): Decision {
  return {
    id: d.id,
    outcome: d.outcome as Decision['outcome'],
    categoryId: d.categoryId,
    severity: d.severity as Severity,
    actionKeys: d.actionKeys,
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    reportIds: d.reportIds,
    ...(d.publicReason !== null && { publicReason: d.publicReason }),
    ...(d.internalNote !== null && { internalNote: d.internalNote }),
  }
}
