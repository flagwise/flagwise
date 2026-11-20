import { describe, expect, it } from 'vitest'
import { acknowledged, cleared, raised, type NotificationRecord } from '../src/domain/lifecycle.ts'

const appRef = { appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-20T09:00:00.000Z').getTime()
const at = (min: number) => new Date(T0 + min * 60_000)
const newId = () => 'ntf_1'
const raise = (min: number, values: Record<string, string> = { caseId: 'case_1' }) => ({ appRef, key: 'new_p0:case_1', type: 'new_p0' as const, values, at: at(min) })
const clear = (min: number) => ({ appRef, key: 'new_p0:case_1', type: 'new_p0' as const, fact: 'case.claimed', at: at(min) })

describe('a notification', () => {
  it('opens on its raise, once', () => {
    const open = raised(null, raise(0), newId)!
    expect(open).toMatchObject({ id: 'ntf_1', state: 'open', raisedAt: at(0), values: { caseId: 'case_1' }, resolvedAt: null })
    expect(raised(open, raise(1), newId)).toBeNull()
    expect(raised(acknowledged(open, at(1))!, raise(2), newId)).toBeNull()
  })

  it('resolves only when its owner clears it, acknowledged or not', () => {
    const open = raised(null, raise(0), newId)!
    const seen = acknowledged(open, at(1))!
    expect(seen).toMatchObject({ state: 'acknowledged', acknowledgedAt: at(1), resolvedAt: null })
    expect(acknowledged(seen, at(2))).toBeNull()
    const done = cleared(seen, clear(3), newId)!
    expect(done).toMatchObject({ state: 'resolved', resolvedAt: at(3), resolvedBy: 'case.claimed', acknowledgedAt: at(1), raisedAt: at(0) })
    expect(cleared(done, clear(4), newId)).toBeNull()
    expect(acknowledged(done, at(5))).toBeNull()
  })

  it('keeps a clear that came first, so the older raise stays resolved', () => {
    const early = cleared(null, clear(5), newId)!
    expect(early).toMatchObject({ state: 'resolved', raisedAt: null, values: {} })
    expect(raised(early, raise(4), newId)).toBeNull()
    expect(raised(early, raise(5), newId)).toBeNull()
  })

  it('opens again on a raise after it was resolved, with the new values and its id', () => {
    const done: NotificationRecord = cleared(raised(null, raise(0), newId)!, clear(1), newId)!
    const again = raised(done, raise(2, { caseId: 'case_1', note: 'again' }), () => 'ntf_2')!
    expect(again).toMatchObject({ id: 'ntf_1', state: 'open', raisedAt: at(2), values: { note: 'again' }, resolvedAt: null, resolvedBy: null, acknowledgedAt: null })
  })
})
