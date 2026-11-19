// Erasure on an in-memory bus: privacy waits for an answer from every consumer group the request
// reached, as the bus reports them, and completes once all have answered.
import { currentType, eventContract } from '@flagwise/contracts'
import { manualClock, type TenantRef } from '@flagwise/kernel'
import { createMemoryBus, memoryUnitOfWork, type BusEvent, type MemoryBus } from '@flagwise/platform'
import { beforeEach, describe, expect, it } from 'vitest'
import { ERASURE_DEADLINE_MS, erasureStatus, privacyService, subscribePrivacy, type ErasureRecord, type ErasureStore, type PrivacyService } from '../src/index.ts'

const tenant: TenantRef = { orgId: 'org_jane', appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-19T09:00:00.000Z')

class Erasures implements ErasureStore {
  readonly rows = new Map<string, ErasureRecord>()
  async find(_t: TenantRef, id: string) {
    return this.rows.get(id) ?? null
  }
  async findActive(_t: TenantRef, subject: string) {
    return [...this.rows.values()].find((r) => r.subjectExternalId === subject && !r.completedAt) ?? null
  }
  async insert(r: ErasureRecord) {
    if (await this.findActive(tenant, r.subjectExternalId)) return false
    this.rows.set(r.id, r)
    return true
  }
  async save(r: ErasureRecord) {
    this.rows.set(r.id, r)
  }
}

let bus: MemoryBus
let erasures: Erasures
let privacy: PrivacyService
let n: number

/** A service's erasure group that answers with `status`, or throws while `down` says so. */
const holder = (group: string, status: 'erased' | 'nothing_held' | 'retained', down = () => false) =>
  bus.subscribe(
    group,
    [currentType('subject.erasure_requested')],
    async (e: BusEvent) => {
      if (down()) throw new Error(`${group} is down`)
      const { erasureId } = e.data as { erasureId: string }
      const data = { erasureId, group, status, heldItems: status === 'retained' ? 2 : 0, reason: status === 'retained' ? 'legal_hold' : null, occurredAt: T0.toISOString() }
      await bus.publish({ id: `subject.erased:${erasureId}:${group}`, type: currentType('subject.erased'), key: erasureId, data, tenant })
    },
    { maxAttempts: 2 },
  )

beforeEach(() => {
  bus = createMemoryBus({ contract: eventContract })
  erasures = new Erasures()
  n = 0
  const deps = { uow: memoryUnitOfWork(bus, { erasures }), clock: manualClock(T0), newErasureId: () => `ers_${++n}` }
  subscribePrivacy(bus, deps)
  privacy = privacyService(deps)
})

const completed = () => bus.log().filter((l) => l.event.type === 'erasure.completed.v1').map((l) => l.event)

describe('erasure', () => {
  it('asks every group that takes the request and completes once each has answered', async () => {
    holder('intake.erasure', 'erased')
    holder('policy.erasure', 'nothing_held')
    holder('cases.erasure', 'retained')
    const { erasure, created } = await privacy.erase(tenant, 'u_john_doe')
    expect(created).toBe(true)
    expect(erasure).toMatchObject({ id: 'ers_1', deadlineAt: new Date(T0.getTime() + ERASURE_DEADLINE_MS), expected: null })
    await bus.drain()

    const done = erasures.rows.get('ers_1')!
    expect(done.expected).toEqual(['cases.erasure', 'intake.erasure', 'policy.erasure'])
    expect(done.groups).toMatchObject({
      'intake.erasure': { status: 'erased' },
      'policy.erasure': { status: 'nothing_held' },
      'cases.erasure': { status: 'retained', heldItems: 2, reason: 'legal_hold' },
    })
    expect(done).toMatchObject({ completedAt: T0, heldItems: 2 })
    expect(erasureStatus(done, T0)).toBe('completed')
    expect(completed()).toEqual([expect.objectContaining({ id: 'erasure.completed:ers_1', key: 'ers_1', data: { erasureId: 'ers_1', subjectExternalId: 'u_john_doe', heldItems: 2, occurredAt: T0.toISOString() } })])
  })

  it('answers with the erasure in progress instead of starting another, and starts anew once it completed', async () => {
    holder('intake.erasure', 'erased', () => true)
    await privacy.erase(tenant, 'u_john_doe')
    expect(await privacy.erase(tenant, 'u_john_doe')).toMatchObject({ erasure: { id: 'ers_1' }, created: false })
    expect((await privacy.erase(tenant, 'u_jane_doe')).erasure.id).toBe('ers_2')
  })

  it('keeps a group that is down as failed and waits for it, completing once it answers after all', async () => {
    let down = true
    holder('intake.erasure', 'erased')
    holder('triage.erasure', 'erased', () => down)
    await privacy.erase(tenant, 'u_john_doe')
    await bus.drain()
    expect(erasures.rows.get('ers_1')).toMatchObject({ completedAt: null, groups: { 'intake.erasure': { status: 'erased' }, 'triage.erasure': { status: 'failed', error: 'triage.erasure is down' } } })
    expect(erasureStatus(erasures.rows.get('ers_1')!, new Date(T0.getTime() + ERASURE_DEADLINE_MS))).toBe('overdue')
    expect(completed()).toEqual([])

    down = false
    expect(bus.retryDeadLetter('triage.erasure', 'subject.erasure_requested:ers_1')).toBe(true)
    await bus.drain()
    expect(erasures.rows.get('ers_1')).toMatchObject({ groups: { 'triage.erasure': { status: 'erased', error: null } } })
    expect(completed()).toHaveLength(1)
  })

  it('completes at once when no group takes the request, and keeps only the first answer of a group', async () => {
    await privacy.erase(tenant, 'u_john_doe')
    await bus.drain()
    expect(completed()).toHaveLength(1)

    holder('intake.erasure', 'erased')
    holder('cases.erasure', 'erased', () => true)
    await privacy.erase(tenant, 'u_jane_doe')
    await bus.drain()
    const answer = { erasureId: 'ers_2', group: 'intake.erasure', status: 'retained', heldItems: 5, reason: 'legal_hold', occurredAt: T0.toISOString() }
    await bus.publish({ id: 'subject.erased:again', type: currentType('subject.erased'), key: 'ers_2', data: answer, tenant })
    await bus.drain()
    expect(erasures.rows.get('ers_2')!.groups['intake.erasure']).toMatchObject({ status: 'erased', heldItems: 0 })
  })
})
