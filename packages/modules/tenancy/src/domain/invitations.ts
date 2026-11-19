// Invitations and org rules. Who may invite whom is the permission matrix in kernel (can); this file
// is about the invitation itself: a single-use token, stored only as a hash, bound to the invited
// email and valid for INVITE_TTL_MS.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Role } from '@flagwise/kernel'

export const INVITE_TTL_MS = 7 * 86_400_000

export interface Invitation {
  readonly orgId: string
  readonly email: string
  readonly role: Role
  readonly appId: string | null
  readonly invitedBy: string
  readonly tokenHash: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly status: 'pending' | 'accepted' | 'revoked'
  readonly acceptedBy: string | null
  readonly acceptedAt: Date | null
}

export interface CreateInvitationInput {
  readonly orgId: string
  readonly email: string
  readonly role: Role
  readonly appId?: string
  readonly invitedBy: string
  readonly now: Date
}

export interface AcceptAttempt {
  readonly token: string
  readonly accountId: string
  readonly accountEmail: string
  readonly emailVerified: boolean
  readonly now: Date
}

export type AcceptFailure = 'invalid_token' | 'revoked' | 'already_used' | 'expired' | 'email_mismatch' | 'email_unverified'

export interface OrgMember {
  readonly memberId: string
  readonly orgRole: 'owner' | 'org_admin' | null
}

export type OrgErrorCode = 'not_pending' | 'not_owner' | 'same_member' | 'not_a_member' | 'target_owns_org'

export class OrgError extends Error {
  readonly code: OrgErrorCode
  constructor(code: OrgErrorCode) {
    super(code)
    this.name = 'OrgError'
    this.code = code
  }
}

type Random = (n: number) => Uint8Array

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function newToken(random?: Random): string {
  const bytes = random ? random(32) : randomBytes(32)
  return Buffer.from(bytes).toString('base64url')
}

/**
 * A new invitation and its token (returned once). The email is trimmed and lowercased and must have
 * exactly one `@` with something on both sides. Role and app must fit: 'owner' is never invited,
 * 'org_admin' takes no app, app roles need one. Otherwise RangeError. The token is base64url without
 * padding of `random(32)`; only its SHA-256 (lowercase hex) is stored.
 */
export function createInvitation(input: CreateInvitationInput, random?: Random): { invitation: Invitation; token: string } {
  const email = input.email.trim().toLowerCase()
  const parts = email.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new RangeError('invalid email')
  if (input.role === 'owner') throw new RangeError('an owner cannot be invited')
  if (input.role === 'org_admin') {
    if (input.appId !== undefined) throw new RangeError('an org admin takes no app')
  } else if (input.appId === undefined) {
    throw new RangeError('an app role needs an app')
  }
  const token = newToken(random)
  const invitation: Invitation = {
    orgId: input.orgId,
    email,
    role: input.role,
    appId: input.appId ?? null,
    invitedBy: input.invitedBy,
    tokenHash: sha256Hex(token),
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    status: 'pending',
    acceptedBy: null,
    acceptedAt: null,
  }
  return { invitation, token }
}

/**
 * Accepts an invitation, or reports the first failing check: 'invalid_token' (hash differs,
 * constant-time compare), 'revoked', 'already_used', 'expired' (now >= expiresAt),
 * 'email_mismatch' (account email, trimmed and lowercased, differs), 'email_unverified'.
 */
export function acceptInvitation(
  invitation: Invitation,
  attempt: AcceptAttempt,
): { ok: true; invitation: Invitation } | { ok: false; reason: AcceptFailure } {
  const given = Buffer.from(sha256Hex(attempt.token), 'hex')
  const stored = Buffer.from(invitation.tokenHash, 'hex')
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return { ok: false, reason: 'invalid_token' }
  if (invitation.status === 'revoked') return { ok: false, reason: 'revoked' }
  if (invitation.status === 'accepted') return { ok: false, reason: 'already_used' }
  if (attempt.now.getTime() >= invitation.expiresAt.getTime()) return { ok: false, reason: 'expired' }
  if (attempt.accountEmail.trim().toLowerCase() !== invitation.email) return { ok: false, reason: 'email_mismatch' }
  if (!attempt.emailVerified) return { ok: false, reason: 'email_unverified' }
  return { ok: true, invitation: { ...invitation, status: 'accepted', acceptedBy: attempt.accountId, acceptedAt: attempt.now } }
}

/** Revokes a pending invitation (expired or not); otherwise OrgError 'not_pending'. */
export function revokeInvitation(invitation: Invitation, now: Date): Invitation {
  if (invitation.status !== 'pending') throw new OrgError('not_pending')
  return { ...invitation, status: 'revoked' }
}

/** A new token and a fresh expiry for a pending invitation, so the old link stops working; otherwise OrgError 'not_pending'. */
export function resendInvitation(invitation: Invitation, now: Date, random?: Random): { invitation: Invitation; token: string } {
  if (invitation.status !== 'pending') throw new OrgError('not_pending')
  const token = newToken(random)
  return {
    invitation: { ...invitation, tokenHash: sha256Hex(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS) },
    token,
  }
}

/** A user owns at most one org. */
export function canCreateOrg(ownedOrgCount: number): boolean {
  return ownedOrgCount < 1
}

/**
 * Hands the org to another member: `toId` becomes owner, `fromId` org_admin, everyone else and the
 * order unchanged. OrgError, in this order: 'not_owner', 'same_member', 'not_a_member',
 * 'target_owns_org'.
 */
export function transferOwnership(
  members: readonly OrgMember[],
  fromId: string,
  toId: string,
  targetOwnsAnotherOrg: boolean,
): OrgMember[] {
  const from = members.find((m) => m.memberId === fromId)
  if (!from || from.orgRole !== 'owner') throw new OrgError('not_owner')
  if (fromId === toId) throw new OrgError('same_member')
  if (!members.some((m) => m.memberId === toId)) throw new OrgError('not_a_member')
  if (targetOwnsAnotherOrg) throw new OrgError('target_owns_org')
  return members.map((m) => {
    if (m.memberId === toId) return { ...m, orgRole: 'owner' as const }
    if (m.memberId === fromId) return { ...m, orgRole: 'org_admin' as const }
    return m
  })
}
