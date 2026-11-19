// What every service that holds data does on subject.erasure_requested: erase its part in one
// transaction and answer with subject.erased from the group that got the request.

import { currentType, type EventData } from './catalog.ts'

/** The tombstone that takes an erased account's id where a record must stay. */
export const erasedId = (erasureId: string): string => `erased_${erasureId}`

/**
 * The subject.erased answer of `group` to `request`, keyed by the erasure, with a natural id per
 * group, so a redelivered request answers once.
 */
export function erasureAnswer(
  request: Pick<EventData<'subject.erasure_requested.v1'>, 'erasureId'>,
  group: string,
  status: 'erased' | 'nothing_held' | 'retained',
  at: Date,
  held: { readonly items: number; readonly reason: string } | null = null,
): { readonly id: string; readonly type: 'subject.erased.v1'; readonly key: string; readonly data: EventData<'subject.erased.v1'> } {
  return {
    id: `subject.erased:${request.erasureId}:${group}`,
    type: currentType('subject.erased') as 'subject.erased.v1',
    key: request.erasureId,
    data: { erasureId: request.erasureId, group, status, heldItems: held?.items ?? 0, reason: held?.reason ?? null, occurredAt: at.toISOString() },
  }
}
