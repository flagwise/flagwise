import { describe, expect, it } from 'vitest'
import { GRACE_DAYS, canRestore, deletionStatus, flaggingStatus, type Deletable } from '../src/domain/lifecycle.ts'

const T0 = new Date('2026-11-03T09:00:00.000Z').getTime()
const DAY = 86_400_000
const at = (ms: number) => new Date(T0 + ms)

const active: Deletable = { deletedAt: null, purgedAt: null }
const deleted = (): Deletable => ({ deletedAt: at(0), purgedAt: null })

describe('deletion grace period', () => {
  it('lasts 30 days', () => {
    expect(GRACE_DAYS).toBe(30)
    expect(deletionStatus(deleted(), at(DAY))).toEqual({ state: 'pending_deletion', purgeAt: at(30 * DAY) })
  })

  it('becomes due for purge at the end of the grace period', () => {
    expect(deletionStatus(deleted(), at(30 * DAY - 1)).state).toBe('pending_deletion')
    expect(deletionStatus(deleted(), at(30 * DAY))).toEqual({ state: 'purge_due', purgeAt: at(30 * DAY) })
  })

  it('reports active and purged entities', () => {
    expect(deletionStatus(active, at(0))).toEqual({ state: 'active', purgeAt: null })
    expect(deletionStatus({ ...deleted(), purgedAt: at(DAY) }, at(2 * DAY)).state).toBe('purged')
  })

  it('answers flagging with 410 once deleted', () => {
    expect(flaggingStatus(active, at(0))).toBe(202)
    expect(flaggingStatus(deleted(), at(DAY))).toBe(410)
    expect(flaggingStatus(deleted(), at(31 * DAY))).toBe(410)
    expect(flaggingStatus({ ...deleted(), purgedAt: at(DAY) }, at(DAY))).toBe(410)
  })

  it('allows a restore only during the grace period', () => {
    expect(canRestore(deleted(), at(DAY))).toBe(true)
    expect(canRestore(deleted(), at(30 * DAY))).toBe(false)
    expect(canRestore(active, at(0))).toBe(false)
    expect(canRestore({ ...deleted(), purgedAt: at(DAY) }, at(DAY))).toBe(false)
  })
})
