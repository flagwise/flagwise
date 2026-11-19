// In-memory fakes for the appeals ports.
import type { TenantRef } from '@flagwise/kernel'
import {
  VersionConflictError,
  type AppealRecord,
  type AppealRepository,
  type AppealsEvent,
  type DecisionRepository,
  type DecisionView,
} from '../src/app/ports.ts'

const same = (a: TenantRef, b: TenantRef) => a.appId === b.appId && a.livemode === b.livemode

export class InMemoryDecisions implements DecisionRepository {
  readonly rows = new Map<string, DecisionView>()
  async findById(tenant: TenantRef, decisionId: string) {
    const d = this.rows.get(decisionId)
    return d && same(d.tenant, tenant) ? structuredClone(d) : null
  }
}

export class InMemoryAppeals implements AppealRepository {
  private readonly rows = new Map<string, AppealRecord>()
  readonly calls: string[] = []
  beforeUpdate: ((r: AppealRecord) => void) | undefined
  failUpdatesWith: Error[] = []

  seed(...rs: AppealRecord[]) {
    for (const r of rs) this.rows.set(r.id, structuredClone(r))
  }
  all() {
    return [...this.rows.values()].map((r) => structuredClone(r))
  }
  get(id: string) {
    const r = this.rows.get(id)
    return r && structuredClone(r)
  }
  async findById(tenant: TenantRef, appealId: string) {
    this.calls.push('findById')
    const r = this.rows.get(appealId)
    return r && same(r.tenant, tenant) ? Object.freeze(structuredClone(r)) : null
  }
  async findByDecision(tenant: TenantRef, decisionId: string) {
    this.calls.push('findByDecision')
    return [...this.rows.values()].filter((r) => same(r.tenant, tenant) && r.decisionId === decisionId).map((r) => Object.freeze(structuredClone(r)))
  }
  async insert(r: AppealRecord) {
    this.calls.push('insert')
    if (this.rows.has(r.id)) throw new Error(`duplicate ${r.id}`)
    this.rows.set(r.id, structuredClone(r))
  }
  async update(r: AppealRecord, expectedVersion: number) {
    this.calls.push('update')
    this.beforeUpdate?.(r)
    const forced = this.failUpdatesWith.shift()
    if (forced) throw forced
    const stored = this.rows.get(r.id)
    if (!stored || stored.version !== expectedVersion) throw new VersionConflictError(r.id)
    this.rows.set(r.id, structuredClone(r))
  }
}

export class RecordingPublisher {
  readonly events: AppealsEvent[] = []
  async publish(e: AppealsEvent) {
    this.events.push(e)
  }
}
