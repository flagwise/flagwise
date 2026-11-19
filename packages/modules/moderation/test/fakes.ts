// In-memory fakes for the cases ports.
import type { TenantRef } from '@flagwise/kernel'
import type { CaseChange, CaseCondition, CaseRecord, CaseRepository, ModerationEvent, EventPublisher } from '../src/app/ports.ts'
import type { CaseState } from '../src/domain/case-state.ts'

const sameTenant = (a: TenantRef, b: TenantRef) => a.appId === b.appId && a.livemode === b.livemode

const copy = (r: CaseRecord): CaseRecord => structuredClone(r)

export class InMemoryCaseRepository implements CaseRepository {
  private readonly rows = new Map<string, CaseRecord>()
  readonly calls: { method: string; caseId?: string }[] = []
  /** Runs inside change() and attachReport() before the condition is checked, e.g. to simulate a concurrent writer. */
  beforeWrite: ((caseId: string) => void) | undefined
  /** Makes the next change() and attachReport() calls throw this error instead of writing. */
  failWritesWith: Error[] = []
  /** The next this-many change() calls return false, as if the condition no longer held. */
  refuseChanges = 0
  failInsertWith: Error | undefined

  seed(...records: CaseRecord[]): void {
    for (const r of records) this.rows.set(r.id, copy(r))
  }

  all(): CaseRecord[] {
    return [...this.rows.values()].map(copy)
  }

  get(id: string): CaseRecord | undefined {
    const r = this.rows.get(id)
    return r && copy(r)
  }

  /** Simulates another writer attaching a report directly. */
  attachDirectly(caseId: string, reportId: string): void {
    const r = this.rows.get(caseId)
    if (!r) throw new Error(`no case ${caseId}`)
    this.rows.set(caseId, { ...r, reportIds: [...r.reportIds, reportId] })
  }

  async findById(tenant: TenantRef, caseId: string): Promise<CaseRecord | null> {
    this.calls.push({ method: 'findById', caseId })
    const r = this.rows.get(caseId)
    return r && sameTenant(r.tenant, tenant) ? Object.freeze(copy(r)) : null
  }

  async findBySubject(tenant: TenantRef, subjectExternalId: string): Promise<readonly CaseRecord[]> {
    this.calls.push({ method: 'findBySubject' })
    return [...this.rows.values()]
      .filter((r) => sameTenant(r.tenant, tenant) && r.subjectExternalId === subjectExternalId)
      .map((r) => Object.freeze(copy(r)))
  }

  async findByReportId(tenant: TenantRef, reportId: string): Promise<CaseRecord | null> {
    this.calls.push({ method: 'findByReportId' })
    const r = [...this.rows.values()].find((c) => sameTenant(c.tenant, tenant) && c.reportIds.includes(reportId))
    return r ? Object.freeze(copy(r)) : null
  }

  async eraseAccount(tenant: TenantRef, externalId: string, erasedId: string): Promise<number> {
    let n = 0
    for (const [id, r] of this.rows) {
      if (!sameTenant(r.tenant, tenant) || r.subjectExternalId !== externalId) continue
      this.rows.set(id, { ...r, subjectExternalId: erasedId })
      n++
    }
    return n
  }

  async lockSubject(): Promise<void> {
    this.calls.push({ method: 'lockSubject' })
  }

  async insert(record: CaseRecord): Promise<void> {
    this.calls.push({ method: 'insert', caseId: record.id })
    if (this.failInsertWith) throw this.failInsertWith
    if (this.rows.has(record.id)) throw new Error(`duplicate id ${record.id}`)
    this.rows.set(record.id, copy(record))
  }

  async change(tenant: TenantRef, caseId: string, condition: CaseCondition, change: CaseChange): Promise<boolean> {
    this.calls.push({ method: 'change', caseId })
    this.beforeWrite?.(caseId)
    const forced = this.failWritesWith.shift()
    if (forced) throw forced
    if (this.refuseChanges > 0) {
      this.refuseChanges--
      return false
    }
    const r = this.rows.get(caseId)
    if (!r || !sameTenant(r.tenant, tenant) || !meets(r, condition)) return false
    this.rows.set(caseId, { ...r, ...structuredClone(change) })
    return true
  }

  async attachReport(tenant: TenantRef, caseId: string, reportId: string, states: readonly CaseState[]): Promise<boolean> {
    this.calls.push({ method: 'attachReport', caseId })
    this.beforeWrite?.(caseId)
    const forced = this.failWritesWith.shift()
    if (forced) throw forced
    const r = this.rows.get(caseId)
    if (!r || !sameTenant(r.tenant, tenant) || !states.includes(r.state)) return false
    this.rows.set(caseId, { ...r, reportIds: [...r.reportIds, reportId] })
    return true
  }

  /** Noted action failures: request id -> case id and whether a retry answered it, in noting order. */
  readonly failures = new Map<string, { caseId: string; tenant: TenantRef; answered: boolean }>()

  async addActionFailure(tenant: TenantRef, caseId: string, actionRequestId: string): Promise<boolean> {
    if (this.failures.has(actionRequestId)) return false
    this.failures.set(actionRequestId, { caseId, tenant, answered: false })
    return true
  }

  async openActionFailures(tenant: TenantRef, caseId: string): Promise<readonly string[]> {
    return [...this.failures].filter(([, f]) => f.caseId === caseId && sameTenant(f.tenant, tenant) && !f.answered).map(([id]) => id)
  }

  async answerActionFailures(_tenant: TenantRef, _caseId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const f = this.failures.get(id)
      if (f) f.answered = true
    }
  }
}

function meets(r: CaseRecord, c: CaseCondition): boolean {
  if (!c.states.includes(r.state)) return false
  if (c.claimedBy === null && r.claim) return false
  if (typeof c.claimedBy === 'string' && r.claim?.memberId !== c.claimedBy) return false
  if (c.claimIdleSince && !(r.claim && r.claim.lastActivityAt.getTime() <= c.claimIdleSince.getTime())) return false
  if (c.decisionId !== undefined && r.decision?.id !== c.decisionId) return false
  return true
}

export class RecordingPublisher implements EventPublisher {
  readonly events: ModerationEvent[] = []
  async publish(event: ModerationEvent): Promise<void> {
    this.events.push(event)
  }
}
