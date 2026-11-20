// A notification's life: open when raised, acknowledged when a person saw it, resolved when its
// owner clears it (by_fact types: never by a click) or, for on_acknowledge types, when
// acknowledged. One per key: raising it again while it is open changes nothing.

import { NOTIFICATION_TYPES, type NotificationType, type NotificationTypeSpec } from '@flagwise/contracts'
import type { AppRef } from '@flagwise/kernel'

export type NotificationState = 'open' | 'acknowledged' | 'resolved'

export interface NotificationRecord {
  readonly id: string
  readonly appRef: AppRef
  readonly key: string
  readonly type: NotificationType
  readonly values: Readonly<Record<string, string>>
  readonly state: NotificationState
  /** Null for a clear that came before its raise: it keeps that older raise from opening it. */
  readonly raisedAt: Date | null
  readonly acknowledgedAt: Date | null
  readonly resolvedAt: Date | null
  /** The owner's fact that cleared it, or `acknowledged`. */
  readonly resolvedBy: string | null
}

export const isNotificationType = (type: string): type is NotificationType => Object.hasOwn(NOTIFICATION_TYPES, type)

export interface Raise {
  readonly appRef: AppRef
  readonly key: string
  readonly type: NotificationType
  readonly values: Readonly<Record<string, string>>
  readonly at: Date
}

/**
 * The record after a raise, or null when it does not change: open or acknowledged already (the
 * same notification), or resolved at or after the raise (its clear came first). A resolved one
 * raised again later opens again, with the new values.
 */
export function raised(existing: NotificationRecord | null, raise: Raise, newId: () => string): NotificationRecord | null {
  if (existing && existing.state !== 'resolved') return null
  if (existing && existing.resolvedAt !== null && existing.resolvedAt.getTime() >= raise.at.getTime()) return null
  return {
    id: existing?.id ?? newId(),
    appRef: raise.appRef,
    key: raise.key,
    type: raise.type,
    values: raise.values,
    state: 'open',
    raisedAt: raise.at,
    acknowledgedAt: null,
    resolvedAt: null,
    resolvedBy: null,
  }
}

export interface Clear {
  readonly appRef: AppRef
  readonly key: string
  readonly type: NotificationType
  readonly fact: string
  readonly at: Date
}

/**
 * The record after its owner cleared it, or null when it does not change (resolved already). A
 * clear for a notification not raised yet is kept as resolved, so an older raise that comes after
 * it stays resolved.
 */
export function cleared(existing: NotificationRecord | null, clear: Clear, newId: () => string): NotificationRecord | null {
  if (existing?.state === 'resolved') return null
  return {
    id: existing?.id ?? newId(),
    appRef: clear.appRef,
    key: clear.key,
    type: clear.type,
    values: existing?.values ?? {},
    state: 'resolved',
    raisedAt: existing?.raisedAt ?? null,
    acknowledgedAt: existing?.acknowledgedAt ?? null,
    resolvedAt: clear.at,
    resolvedBy: clear.fact,
  }
}

/**
 * The record once a person acknowledged it, or null when it does not change (acknowledged or
 * resolved already). An on_acknowledge type resolves; a by_fact one stays until its owner clears it.
 */
export function acknowledged(existing: NotificationRecord, at: Date): NotificationRecord | null {
  if (existing.state !== 'open') return null
  if ((NOTIFICATION_TYPES[existing.type] as NotificationTypeSpec).clears === 'on_acknowledge') return { ...existing, state: 'resolved', acknowledgedAt: at, resolvedAt: at, resolvedBy: 'acknowledged' }
  return { ...existing, state: 'acknowledged', acknowledgedAt: at }
}
