import { manualClock, type ManualClock, type TenantRef } from '@flagwise/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ERASURE_DEADLINE_MS,
  ERASURE_MODULES,
  ErasureError,
  VersionConflictError,
  checkOverdue,
  recordModuleErased,
  retryPending,
  startErasure,
  type ErasureDeps,
  type ErasureEvent,
  type ErasureRecord,
  type ErasureRepository,
} from '../src/app/erasure.ts'

const tenant: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-03T09:00:00.000Z')
const H = 3_600_000
const same = (a: TenantRef, b: TenantRef) => a.orgId === b.orgId && a.appId === b.appId && a.livemode === b.livemode

class Repo implements ErasureRepository {
  readonly rows = new Map<string, ErasureRecord>()
  updates = 0
  inserts = 0
  failUpdatesWith: Error[] = []
  beforeUpdate: (() => void) | undefined
  async findById(t: TenantRef, id: string) {
    const r = this.rows.get(id)
    return r && same(r.tenant, t) ? Object.freeze(structuredClone(r)) : null
  }
  async findActive(t: TenantRef, subject: string) {
    const r = [...this.rows.values()].find((x) => same(x.tenant, t) && x.subjectExternalId === subject && x.status === 'in_progress')
    return r ? Object.freeze(structuredClone(r)) : null
  }
  async insert(r: ErasureRecord) {
    this.inserts++
    this.rows.set(r.id, structuredClone(r))
  }
  async update(r: ErasureRecord, expected: number) {
    this.updates++
    this.beforeUpdate?.()
    const forced = this.failUpdatesWith.shift()
    if (forced) throw forced
    if (this.rows.get(r.id)?.version !== expected) throw new VersionConflictError(r.id)
    this.rows.set(r.id, structuredClone(r))
  }
}

let repo: Repo
let events: ErasureEvent[]
let clock: ManualClock
let deps: ErasureDeps
let ids: number

beforeEach(() => {
  repo = new Repo()
  events = []
  clock = manualClock(T0)
  ids = 0
  deps = { erasures: repo, events: { publish: async (e) => void events.push(e) }, clock, newErasureId: () => `ers_${++ids}` }
})

const start = (subjectExternalId = 'u_5531') => startErasure(deps, { tenant, subjectExternalId })
const ack = (module: string, heldItems = 0, erasureId = 'ers_1') => recordModuleErased(deps, { tenant, erasureId, module, heldItems })

async function rejectsWith(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => expect.unreachable('should have thrown'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ErasureError)
  expect((err as ErasureError).code).toBe(code)
}

describe('startErasure', () => {
  it('creates an erasure and asks every module', async () => {
    const { erasure, created } = await start()
    expect(created).toBe(true)
    expect(erasure).toEqual({
      id: 'ers_1',
      tenant,
      subjectExternalId: 'u_5531',
      requestedAt: T0,
      deadlineAt: new Date(T0.getTime() + 24 * H),
      status: 'in_progress',
      acks: {},
      overdueNotified: false,
      completedAt: null,
      version: 1,
    })
    expect(repo.rows.get('ers_1')).toEqual(erasure)
    expect(events).toEqual([
      { type: 'subject.erasure_requested', tenant, erasureId: 'ers_1', subjectExternalId: 'u_5531', modules: [...ERASURE_MODULES], occurredAt: T0 },
    ])
  })

  it('returns the running erasure instead of starting another', async () => {
    await start()
    clock.advance(H)
    const again = await start()
    expect(again.created).toBe(false)
    expect(again.erasure.id).toBe('ers_1')
    expect(repo.inserts).toBe(1)
    expect(events).toHaveLength(1)
  })

  it('starts a new one once the previous erasure completed', async () => {
    await start()
    for (const m of ERASURE_MODULES) await ack(m)
    expect((await start()).erasure.id).toBe('ers_2')
  })

  it('keeps subjects apart', async () => {
    await start('u_1')
    expect((await start('u_2')).created).toBe(true)
  })

  it('has a 24 hour deadline', () => {
    expect(ERASURE_DEADLINE_MS).toBe(24 * H)
  })
})

describe('recordModuleErased', () => {
  it('records acks and completes when the last module reports', async () => {
    await start()
    const held: Record<string, number> = { cases: 2, audit: 1 }
    for (const [i, m] of ERASURE_MODULES.entries()) {
      clock.advance(H)
      const r = await ack(m, held[m] ?? 0)
      expect(r.version).toBe(i + 2)
      expect(r.status).toBe(i === ERASURE_MODULES.length - 1 ? 'completed' : 'in_progress')
    }
    const done = repo.rows.get('ers_1')!
    expect(done.completedAt).toEqual(new Date(T0.getTime() + 7 * H))
    expect(done.acks.cases).toEqual({ at: new Date(T0.getTime() + 2 * H), heldItems: 2 })
    expect(events.slice(1)).toEqual([
      { type: 'subject.erased', tenant, erasureId: 'ers_1', subjectExternalId: 'u_5531', heldItems: 3, occurredAt: new Date(T0.getTime() + 7 * H) },
    ])
  })

  it('accepts acks in any order', async () => {
    await start()
    for (const m of [...ERASURE_MODULES].reverse()) await ack(m)
    expect(repo.rows.get('ers_1')?.status).toBe('completed')
    expect(events.filter((e) => e.type === 'subject.erased')).toHaveLength(1)
  })

  it('ignores a module reporting twice', async () => {
    await start()
    await ack('cases', 2)
    clock.advance(H)
    const r = await ack('cases', 5)
    expect(r.version).toBe(2)
    expect(r.acks.cases).toEqual({ at: T0, heldItems: 2 })
    expect(repo.updates).toBe(1)
  })

  it('ignores acks after completion', async () => {
    await start()
    for (const m of ERASURE_MODULES) await ack(m)
    const before = repo.updates
    await ack('cases')
    expect(repo.updates).toBe(before)
    expect(events.filter((e) => e.type === 'subject.erased')).toHaveLength(1)
  })

  it('checks erasure, module and held items, in that order', async () => {
    await rejectsWith(ack('cases'), 'not_found')
    await start()
    await rejectsWith(ack('billing'), 'unknown_module')
    await rejectsWith(ack('billing', -1), 'unknown_module')
    await rejectsWith(ack('cases', -1), 'invalid_held_items')
    await rejectsWith(ack('cases', 1.5), 'invalid_held_items')
    await rejectsWith(recordModuleErased(deps, { tenant: { ...tenant, appId: 'app_b' }, erasureId: 'ers_1', module: 'cases', heldItems: 0 }), 'not_found')
  })

  it('retries when another module wrote at the same time', async () => {
    await start()
    let first = true
    repo.beforeUpdate = () => {
      if (first) {
        first = false
        const r = repo.rows.get('ers_1')!
        repo.rows.set('ers_1', { ...r, acks: { ...r.acks, scoring: { at: T0, heldItems: 4 } }, version: r.version + 1 })
      }
    }
    const r = await ack('cases', 1)
    expect(Object.keys(r.acks).sort()).toEqual(['cases', 'scoring'])
    expect(r.version).toBe(3)
  })

  it('completes on the retry when the other writer was the second-to-last module', async () => {
    await start()
    for (const m of ERASURE_MODULES.slice(0, 5)) await ack(m)
    let first = true
    repo.beforeUpdate = () => {
      if (first) {
        first = false
        const r = repo.rows.get('ers_1')!
        repo.rows.set('ers_1', { ...r, acks: { ...r.acks, audit: { at: T0, heldItems: 1 } }, version: r.version + 1 })
      }
    }
    const r = await ack('metrics')
    expect(r.status).toBe('completed')
    expect(events.filter((e) => e.type === 'subject.erased')).toEqual([expect.objectContaining({ heldItems: 1 })])
  })

  it('gives up after three conflicts', async () => {
    await start()
    repo.failUpdatesWith = [1, 2, 3].map(() => new VersionConflictError('ers_1'))
    await expect(ack('cases')).rejects.toBeInstanceOf(VersionConflictError)
    expect(repo.updates).toBe(3)
  })
})

describe('retryPending', () => {
  it('asks only the modules that have not reported', async () => {
    await start()
    await ack('cases')
    await ack('audit')
    clock.advance(H)
    expect(await retryPending(deps, { tenant, erasureId: 'ers_1' })).toEqual(['intake', 'scoring', 'appeals', 'delivery', 'metrics'])
    expect(events.at(-1)).toEqual({
      type: 'subject.erasure_requested',
      tenant,
      erasureId: 'ers_1',
      subjectExternalId: 'u_5531',
      modules: ['intake', 'scoring', 'appeals', 'delivery', 'metrics'],
      occurredAt: new Date(T0.getTime() + H),
    })
    expect(repo.updates).toBe(2)
  })

  it('does nothing for a completed erasure and refuses an unknown one', async () => {
    await start()
    for (const m of ERASURE_MODULES) await ack(m)
    const count = events.length
    expect(await retryPending(deps, { tenant, erasureId: 'ers_1' })).toEqual([])
    expect(events).toHaveLength(count)
    await rejectsWith(retryPending(deps, { tenant, erasureId: 'ers_x' }), 'not_found')
  })
})

describe('checkOverdue', () => {
  const check = () => checkOverdue(deps, { tenant, erasureId: 'ers_1' })

  it('alerts once when the deadline passes with modules missing', async () => {
    await start()
    await ack('cases')
    clock.set(new Date(T0.getTime() + 24 * H - 1))
    expect(await check()).toBe(false)
    clock.set(new Date(T0.getTime() + 24 * H))
    expect(await check()).toBe(true)
    expect(events.at(-1)).toEqual({
      type: 'erasure.overdue',
      tenant,
      erasureId: 'ers_1',
      subjectExternalId: 'u_5531',
      pendingModules: ['intake', 'scoring', 'appeals', 'delivery', 'audit', 'metrics'],
      occurredAt: new Date(T0.getTime() + 24 * H),
    })
    expect(repo.rows.get('ers_1')).toMatchObject({ overdueNotified: true, version: 3 })
    clock.advance(H)
    expect(await check()).toBe(false)
    expect(events.filter((e) => e.type === 'erasure.overdue')).toHaveLength(1)
  })

  it('does not alert for a completed erasure', async () => {
    await start()
    for (const m of ERASURE_MODULES) await ack(m)
    clock.advance(48 * H)
    expect(await check()).toBe(false)
  })

  it('refuses an unknown erasure and does not retry conflicts', async () => {
    await rejectsWith(check(), 'not_found')
    await start()
    clock.advance(25 * H)
    repo.failUpdatesWith = [new VersionConflictError('ers_1')]
    await expect(check()).rejects.toBeInstanceOf(VersionConflictError)
    expect(events.filter((e) => e.type === 'erasure.overdue')).toEqual([])
  })
})
