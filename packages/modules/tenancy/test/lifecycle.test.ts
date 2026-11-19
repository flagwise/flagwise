import { describe, expect, it } from 'vitest'
import {
  GRACE_DAYS,
  TRANSFER_PLAN,
  canDeleteOrg,
  canRestore,
  deletionStatus,
  flaggingStatus,
  planAppTransfer,
  planDowngrade,
  type Deletable,
  type TransferInput,
} from '../src/domain/lifecycle.ts'

const T0 = new Date('2026-11-03T09:00:00.000Z').getTime()
const DAY = 86_400_000
const at = (ms: number) => new Date(T0 + ms)

const active: Deletable = { deletedAt: null, purgedAt: null, plan: 'free' }
const deleted = (plan: 'free' | 'pro'): Deletable => ({ deletedAt: at(0), purgedAt: null, plan })

describe('deletion grace period', () => {
  it('uses 7 days on Free and 30 on Pro', () => {
    expect(GRACE_DAYS).toEqual({ free: 7, pro: 30 })
    expect(deletionStatus(deleted('free'), at(DAY))).toEqual({ state: 'pending_deletion', purgeAt: at(7 * DAY) })
    expect(deletionStatus(deleted('pro'), at(DAY))).toEqual({ state: 'pending_deletion', purgeAt: at(30 * DAY) })
  })

  it('becomes due for purge at the end of the grace period', () => {
    expect(deletionStatus(deleted('free'), at(7 * DAY - 1)).state).toBe('pending_deletion')
    expect(deletionStatus(deleted('free'), at(7 * DAY))).toEqual({ state: 'purge_due', purgeAt: at(7 * DAY) })
  })

  it('reports active and purged entities', () => {
    expect(deletionStatus(active, at(0))).toEqual({ state: 'active', purgeAt: null })
    expect(deletionStatus({ ...deleted('pro'), purgedAt: at(DAY) }, at(2 * DAY)).state).toBe('purged')
  })

  it('answers flagging with 410 once deleted', () => {
    expect(flaggingStatus(active, at(0))).toBe(202)
    expect(flaggingStatus(deleted('pro'), at(DAY))).toBe(410)
    expect(flaggingStatus(deleted('free'), at(8 * DAY))).toBe(410)
    expect(flaggingStatus({ ...deleted('free'), purgedAt: at(DAY) }, at(DAY))).toBe(410)
  })

  it('allows a restore only during the grace period', () => {
    expect(canRestore(deleted('free'), at(DAY))).toBe(true)
    expect(canRestore(deleted('free'), at(7 * DAY))).toBe(false)
    expect(canRestore(active, at(0))).toBe(false)
    expect(canRestore({ ...deleted('pro'), purgedAt: at(DAY) }, at(DAY))).toBe(false)
  })
})

describe('canDeleteOrg', () => {
  it('needs the Owner and no active Pro subscription', () => {
    expect(canDeleteOrg({ isOwner: true, proActive: false })).toEqual({ ok: true })
    expect(canDeleteOrg({ isOwner: true, proActive: true })).toEqual({ ok: false, reason: 'cancel_pro_first' })
    expect(canDeleteOrg({ isOwner: false, proActive: true })).toEqual({ ok: false, reason: 'not_owner' })
  })
})

describe('planAppTransfer', () => {
  const ok: TransferInput = {
    appRegion: 'sgp',
    appActive: true,
    source: { orgId: 'org_src', ownerId: 'usr_a' },
    target: { orgId: 'org_dst', ownerId: 'usr_b', region: 'sgp', plan: 'pro', appCount: 4 },
    requestedBy: 'usr_a',
    acceptedBy: 'usr_b',
  }

  it('returns the transfer plan', () => {
    expect(planAppTransfer(ok)).toEqual({ ok: true, plan: TRANSFER_PLAN })
    expect(TRANSFER_PLAN).toEqual({
      moves: ['cases', 'audit_trail', 'evidence', 'identifier_hashes', 'api_keys'],
      stays: ['credits', 'credit_ledger'],
      drops: ['moderator_assignments'],
      prompts: [
        { org: 'target', action: 'rotate_api_keys' },
        { org: 'source', action: 'rotate_hmac_key' },
      ],
      auditEntries: ['source', 'target'],
    })
  })

  it('allows a Free target with no app yet', () => {
    expect(planAppTransfer({ ...ok, target: { ...ok.target, plan: 'free', appCount: 0 } }).ok).toBe(true)
  })

  it.each<[string, Partial<TransferInput>]>([
    ['same_org', { target: { ...ok.target, orgId: 'org_src' } }],
    ['not_source_owner', { requestedBy: 'usr_x' }],
    ['not_target_owner', { acceptedBy: 'usr_a' }],
    ['app_deleted', { appActive: false }],
    ['region_mismatch', { appRegion: 'fra' }],
    ['target_app_limit', { target: { ...ok.target, plan: 'free', appCount: 1 } }],
  ])('fails with %s', (reason, patch) => {
    expect(planAppTransfer({ ...ok, ...patch })).toEqual({ ok: false, reason })
  })

  it('reports the first failing check', () => {
    expect(planAppTransfer({ ...ok, requestedBy: 'usr_x', acceptedBy: 'usr_x', appActive: false })).toEqual({ ok: false, reason: 'not_source_owner' })
    expect(planAppTransfer({ ...ok, appRegion: 'fra', target: { ...ok.target, plan: 'free', appCount: 3 } })).toEqual({ ok: false, reason: 'region_mismatch' })
  })
})

describe('planDowngrade', () => {
  it('keeps the oldest app writable', () => {
    const apps = [
      { id: 'app_c', createdAt: at(3 * DAY) },
      { id: 'app_a', createdAt: at(DAY) },
      { id: 'app_b', createdAt: at(2 * DAY) },
    ]
    expect(planDowngrade(apps)).toEqual({ writable: 'app_a', readOnly: ['app_b', 'app_c'] })
  })

  it('breaks ties by id', () => {
    expect(planDowngrade([{ id: 'app_z', createdAt: at(0) }, { id: 'app_m', createdAt: at(0) }])).toEqual({ writable: 'app_m', readOnly: ['app_z'] })
  })

  it('handles one or no app', () => {
    expect(planDowngrade([{ id: 'app_a', createdAt: at(0) }])).toEqual({ writable: 'app_a', readOnly: [] })
    expect(planDowngrade([])).toEqual({ writable: null, readOnly: [] })
  })
})
