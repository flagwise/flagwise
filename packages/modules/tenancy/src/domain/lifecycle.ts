// App lifecycle: a deleted app is kept for a grace period, while it can be restored, and is then
// due to be purged.

/** How long a deleted app can be restored before it is due to be purged. */
export const GRACE_DAYS = 30

export interface Deletable {
  readonly deletedAt: Date | null
  readonly purgedAt: Date | null
}

export type DeletionState = 'active' | 'pending_deletion' | 'purge_due' | 'purged'

/**
 * 'purged' when purgedAt is set; 'active' when deletedAt is null; otherwise purgeAt = deletedAt +
 * GRACE_DAYS days, 'pending_deletion' while now < purgeAt, then 'purge_due'.
 */
export function deletionStatus(entity: Deletable, now: Date): { state: DeletionState; purgeAt: Date | null } {
  if (entity.purgedAt) return { state: 'purged', purgeAt: null }
  if (!entity.deletedAt) return { state: 'active', purgeAt: null }
  const purgeAt = new Date(entity.deletedAt.getTime() + GRACE_DAYS * 86_400_000)
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
