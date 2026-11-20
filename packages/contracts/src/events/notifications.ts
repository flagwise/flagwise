// Notifications to people: a service raises one about its own facts (notification.raised) and,
// for one that clears by fact, clears it (notification.cleared) when its clearing fact happens.
// The notifications service keeps them and takes them to people; it knows no other service's facts.

import { currentType, type EventData, type FactName } from './catalog.ts'

export interface NotificationTypeSpec {
  /** The one service that raises and clears it. */
  readonly owner: string
  /**
   * by_fact: resolved only when the owner clears it, on one of `clearedBy`, never by a click;
   * on_acknowledge: resolved when a person acknowledges it; on_send: resolved once sent.
   */
  readonly clears: 'by_fact' | 'on_acknowledge' | 'on_send'
  /** The owner's facts that clear it (by_fact). */
  readonly clearedBy?: readonly FactName[]
  readonly meaning: string
  /** What its values hold, by name. */
  readonly values: readonly string[]
}

export const NOTIFICATION_TYPES = {
  new_p0: {
    owner: 'moderation',
    clears: 'by_fact',
    clearedBy: ['case.claimed'],
    meaning: 'A P0 case is open and nobody has claimed it: from the pre-rules when the case opens, or from triage.',
    values: ['caseId'],
  },
  sla_75: {
    owner: 'moderation',
    clears: 'by_fact',
    clearedBy: ['case.decided'],
    meaning: "An undecided case has used 75% of its SLA.",
    values: ['caseId', 'slaDueAt'],
  },
  sla_breach: {
    owner: 'moderation',
    clears: 'by_fact',
    clearedBy: ['case.decided'],
    meaning: 'An undecided case is past its SLA.',
    values: ['caseId', 'slaDueAt'],
  },
  action_overdue: {
    owner: 'delivery',
    clears: 'by_fact',
    clearedBy: ['action.confirmed', 'action.failed'],
    meaning: "The app's systems have not answered an action request for 24 hours.",
    values: ['actionRequestId', 'caseId', 'actionKey'],
  },
} as const satisfies Readonly<Record<string, NotificationTypeSpec>>

export type NotificationType = keyof typeof NOTIFICATION_TYPES
export const NOTIFICATION_TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as [NotificationType, ...NotificationType[]]

/** The key of the notification of `type` about `about` (a case, an action request): one per pair. */
export const notificationKey = (type: NotificationType, about: string): string => `${type}:${about}`

type Raised = { readonly id: string; readonly type: 'notification.raised.v1'; readonly key: string; readonly data: EventData<'notification.raised.v1'> }
type Cleared = { readonly id: string; readonly type: 'notification.cleared.v1'; readonly key: string; readonly data: EventData<'notification.cleared.v1'> }

/** notification.raised for the notification of `type` about `about`, keyed by the notification. */
export function notificationRaised(type: NotificationType, about: string, values: Readonly<Record<string, string>>, at: Date): Raised {
  const key = notificationKey(type, about)
  return { id: `notification.raised:${key}:${at.getTime()}`, type: currentType('notification.raised') as 'notification.raised.v1', key, data: { key, type, values: { ...values }, occurredAt: at.toISOString() } }
}

/** notification.cleared for the notification of `type` about `about`, because of `fact`. */
export function notificationCleared(type: NotificationType, about: string, fact: FactName, at: Date): Cleared {
  const key = notificationKey(type, about)
  return { id: `notification.cleared:${key}:${at.getTime()}`, type: currentType('notification.cleared') as 'notification.cleared.v1', key, data: { key, type, fact, occurredAt: at.toISOString() } }
}
