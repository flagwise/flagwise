// App and org lifecycle: deletion grace periods, moving an app to another org, and downgrades.

export type Plan = 'free' | 'pro'

export const GRACE_DAYS: Readonly<Record<Plan, number>> = { free: 7, pro: 30 }

export interface Deletable {
  readonly deletedAt: Date | null
  readonly purgedAt: Date | null
  readonly plan: Plan
}

export type DeletionState = 'active' | 'pending_deletion' | 'purge_due' | 'purged'

export interface TransferInput {
  readonly appRegion: string
  readonly appActive: boolean
  readonly source: { readonly orgId: string; readonly ownerId: string }
  readonly target: { readonly orgId: string; readonly ownerId: string; readonly region: string; readonly plan: Plan; readonly appCount: number }
  readonly requestedBy: string
  readonly acceptedBy: string
}

export type TransferFailure = 'same_org' | 'not_source_owner' | 'not_target_owner' | 'app_deleted' | 'region_mismatch' | 'target_app_limit'

/** What happens to an app's data when it moves to another org. */
export const TRANSFER_PLAN = {
  moves: ['cases', 'audit_trail', 'evidence', 'identifier_hashes', 'api_keys'],
  stays: ['credits', 'credit_ledger'],
  drops: ['moderator_assignments'],
  prompts: [
    { org: 'target', action: 'rotate_api_keys' },
    { org: 'source', action: 'rotate_hmac_key' },
  ],
  auditEntries: ['source', 'target'],
} as const

/**
 * 'purged' when purgedAt is set; 'active' when deletedAt is null; otherwise purgeAt = deletedAt +
 * GRACE_DAYS[plan] days, 'pending_deletion' while now < purgeAt, then 'purge_due'. `plan` is the
 * plan when the entity was deleted.
 */
export function deletionStatus(entity: Deletable, now: Date): { state: DeletionState; purgeAt: Date | null } {
  if (entity.purgedAt) return { state: 'purged', purgeAt: null }
  if (!entity.deletedAt) return { state: 'active', purgeAt: null }
  const purgeAt = new Date(entity.deletedAt.getTime() + GRACE_DAYS[entity.plan] * 86_400_000)
  return { state: now.getTime() < purgeAt.getTime() ? 'pending_deletion' : 'purge_due', purgeAt }
}

/** 202 while active, 410 in every other state. */
export function flaggingStatus(entity: Deletable, now: Date): 202 | 410 {
  return deletionStatus(entity, now).state === 'active' ? 202 : 410
}

/** Only while 'pending_deletion'. */
export function canRestore(entity: Deletable, now: Date): boolean {
  return deletionStatus(entity, now).state === 'pending_deletion'
}

/** Only the Owner, and only once Pro is cancelled: 'not_owner' first, then 'cancel_pro_first'. */
export function canDeleteOrg(input: { readonly isOwner: boolean; readonly proActive: boolean }): { ok: true } | { ok: false; reason: 'not_owner' | 'cancel_pro_first' } {
  if (!input.isOwner) return { ok: false, reason: 'not_owner' }
  if (input.proActive) return { ok: false, reason: 'cancel_pro_first' }
  return { ok: true }
}

/**
 * The transfer plan, or the first failing check: 'same_org', 'not_source_owner' (requestedBy is not
 * the source owner), 'not_target_owner' (acceptedBy is not the target owner), 'app_deleted',
 * 'region_mismatch', 'target_app_limit' (target on Free already has an app).
 */
export function planAppTransfer(input: TransferInput): { ok: true; plan: typeof TRANSFER_PLAN } | { ok: false; reason: TransferFailure } {
  const { source, target } = input
  if (source.orgId === target.orgId) return { ok: false, reason: 'same_org' }
  if (input.requestedBy !== source.ownerId) return { ok: false, reason: 'not_source_owner' }
  if (input.acceptedBy !== target.ownerId) return { ok: false, reason: 'not_target_owner' }
  if (!input.appActive) return { ok: false, reason: 'app_deleted' }
  if (input.appRegion !== target.region) return { ok: false, reason: 'region_mismatch' }
  if (target.plan === 'free' && target.appCount >= 1) return { ok: false, reason: 'target_app_limit' }
  return { ok: true, plan: TRANSFER_PLAN }
}

/**
 * From Pro to Free an org keeps one writable app, the oldest (by createdAt, ties by id); the others
 * become read-only, oldest first. Data is kept either way.
 */
export function planDowngrade(apps: readonly { readonly id: string; readonly createdAt: Date }[]): { writable: string | null; readOnly: string[] } {
  const sorted = [...apps].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { writable: sorted[0]?.id ?? null, readOnly: sorted.slice(1).map((a) => a.id) }
}
