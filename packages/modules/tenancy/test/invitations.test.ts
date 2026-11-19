// Token vectors computed in Python.
import { describe, expect, it } from 'vitest'
import {
  INVITE_TTL_MS,
  MemberError,
  acceptInvitation,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
  type CreateInvitationInput,
  type Invitation,
  type Member,
} from '../src/domain/invitations.ts'

const NOW = new Date('2026-11-03T09:00:00.000Z')
const DAY = 86_400_000
const later = (ms: number) => new Date(NOW.getTime() + ms)
const bytesFrom = (start: number) => (n: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) % 256)

const TOKEN_0 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const HASH_0 = 'ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0'
const TOKEN_100 = 'ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM'
const HASH_100 = '45827150f595bab19278b82d22eba203d126486c59732655abb65ea67d209ee6'

const input = (o: Partial<CreateInvitationInput> = {}): CreateInvitationInput => ({
  email: '  Jane.Doe@Example.COM ',
  role: 'moderator',
  appId: 'app_a',
  invitedBy: 'mem_owner',
  now: NOW,
  ...o,
})

const pending = (): Invitation => createInvitation(input(), bytesFrom(0)).invitation
const attempt = (o: Partial<Parameters<typeof acceptInvitation>[1]> = {}) => ({
  token: TOKEN_0,
  accountId: 'usr_jane',
  accountEmail: 'jane.doe@example.com',
  emailVerified: true,
  now: later(DAY),
  ...o,
})

function throwsMember(fn: () => unknown, code: string) {
  try {
    fn()
    expect.unreachable('should have thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(MemberError)
    expect((e as MemberError).code).toBe(code)
  }
}

describe('createInvitation', () => {
  it('builds the invitation and returns the token once', () => {
    const calls: number[] = []
    const { invitation, token } = createInvitation(input(), (n) => (calls.push(n), bytesFrom(0)(n)))
    expect(token).toBe(TOKEN_0)
    expect(calls).toEqual([32])
    expect(invitation).toEqual({
      email: 'jane.doe@example.com',
      role: 'moderator',
      appId: 'app_a',
      invitedBy: 'mem_owner',
      tokenHash: HASH_0,
      createdAt: NOW,
      expiresAt: later(7 * DAY),
      status: 'pending',
      acceptedBy: null,
      acceptedAt: null,
    })
    expect(JSON.stringify(invitation)).not.toContain(TOKEN_0)
  })

  it('uses base64url, with - and _', () => {
    expect(createInvitation(input(), bytesFrom(100)).token).toBe(TOKEN_100)
  })

  it('makes random tokens by default', () => {
    const a = createInvitation(input()).token
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(createInvitation(input()).token)
  })

  it('invites an Admin without an app', () => {
    expect(createInvitation(input({ role: 'admin', appId: undefined as unknown as string }), bytesFrom(0)).invitation.appId).toBeNull()
  })

  it.each<Partial<CreateInvitationInput>>([
    { role: 'owner', appId: undefined as unknown as string },
    { role: 'admin', appId: 'app_a' },
    { role: 'developer', appId: undefined as unknown as string },
    { email: 'not-an-email' },
    { email: 'a@@b.co' },
    { email: '@b.co' },
  ])('rejects %o', (patch) => {
    const i = { ...input(), ...patch }
    if (i.appId === undefined) delete (i as { appId?: string }).appId
    expect(() => createInvitation(i, bytesFrom(0))).toThrow(RangeError)
  })

  it('keeps the TTL at 7 days', () => {
    expect(INVITE_TTL_MS).toBe(7 * DAY)
  })
})

describe('acceptInvitation', () => {
  it('accepts the right token from the invited, verified email', () => {
    const r = acceptInvitation(pending(), attempt({ accountEmail: ' JANE.doe@example.com' }))
    expect(r).toEqual({ ok: true, invitation: { ...pending(), status: 'accepted', acceptedBy: 'usr_jane', acceptedAt: later(DAY) } })
  })

  it.each<[string, Partial<ReturnType<typeof attempt>>, (i: Invitation) => Invitation]>([
    ['invalid_token', { token: TOKEN_100 }, (i) => i],
    ['revoked', {}, (i) => ({ ...i, status: 'revoked' })],
    ['already_used', {}, (i) => ({ ...i, status: 'accepted', acceptedBy: 'usr_x', acceptedAt: NOW })],
    ['expired', { now: later(7 * DAY) }, (i) => i],
    ['email_mismatch', { accountEmail: 'john@example.com' }, (i) => i],
    ['email_unverified', { emailVerified: false }, (i) => i],
  ])('fails with %s', (reason, patch, change) => {
    expect(acceptInvitation(change(pending()), attempt(patch))).toEqual({ ok: false, reason })
  })

  it('accepts just before expiry', () => {
    expect(acceptInvitation(pending(), attempt({ now: later(7 * DAY - 1) })).ok).toBe(true)
  })

  it('checks the token before anything else', () => {
    const used = { ...pending(), status: 'revoked' as const }
    expect(acceptInvitation(used, attempt({ token: 'nope', now: later(30 * DAY), emailVerified: false }))).toEqual({ ok: false, reason: 'invalid_token' })
    expect(acceptInvitation(used, attempt({ now: later(30 * DAY) }))).toEqual({ ok: false, reason: 'revoked' })
    expect(acceptInvitation(pending(), attempt({ now: later(30 * DAY), accountEmail: 'x@y.co' }))).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('revokeInvitation and resendInvitation', () => {
  it('revokes a pending invitation', () => {
    expect(revokeInvitation(pending(), later(DAY))).toEqual({ ...pending(), status: 'revoked' })
  })

  it('resends with a new token and a new expiry, invalidating the old link', () => {
    const { invitation, token } = resendInvitation(pending(), later(10 * DAY), bytesFrom(100))
    expect(token).toBe(TOKEN_100)
    expect(invitation).toEqual({ ...pending(), tokenHash: HASH_100, expiresAt: later(17 * DAY) })
    expect(acceptInvitation(invitation, attempt({ now: later(11 * DAY) }))).toEqual({ ok: false, reason: 'invalid_token' })
    expect(acceptInvitation(invitation, attempt({ token: TOKEN_100, now: later(11 * DAY) })).ok).toBe(true)
  })

  it('only changes pending invitations', () => {
    const accepted = { ...pending(), status: 'accepted' as const }
    const revoked = { ...pending(), status: 'revoked' as const }
    throwsMember(() => revokeInvitation(accepted, NOW), 'not_pending')
    throwsMember(() => revokeInvitation(revoked, NOW), 'not_pending')
    throwsMember(() => resendInvitation(accepted, NOW, bytesFrom(1)), 'not_pending')
    throwsMember(() => resendInvitation(revoked, NOW, bytesFrom(1)), 'not_pending')
    expect(resendInvitation(pending(), later(30 * DAY), bytesFrom(1)).invitation.status).toBe('pending')
  })
})

describe('member rules', () => {
  const members: Member[] = [
    { memberId: 'mem_owner', adminRole: 'owner' },
    { memberId: 'mem_admin', adminRole: 'admin' },
    { memberId: 'mem_mod', adminRole: null },
  ]

  it('transfers ownership and keeps the former owner as Admin', () => {
    expect(transferOwnership(members, 'mem_owner', 'mem_mod')).toEqual([
      { memberId: 'mem_owner', adminRole: 'admin' },
      { memberId: 'mem_admin', adminRole: 'admin' },
      { memberId: 'mem_mod', adminRole: 'owner' },
    ])
    expect(members[0]?.adminRole).toBe('owner')
  })

  it.each<[string, string, string]>([
    ['not_owner', 'mem_admin', 'mem_mod'],
    ['same_member', 'mem_owner', 'mem_owner'],
    ['not_a_member', 'mem_owner', 'mem_ghost'],
    ['not_owner', 'mem_admin', 'mem_admin'],
  ])('fails with %s', (code, from, to) => {
    throwsMember(() => transferOwnership(members, from, to), code)
  })
})
