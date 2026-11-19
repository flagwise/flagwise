// Erasing an account: privacy publishes subject.erasure_requested tracked, so the bus says which
// consumer groups it reached (bus.event_fanned_out); each answers with subject.erased, and the
// erasure completes once every one of them has. There is no list of services to keep: a service
// that subscribes is asked, and one that is down stays pending. Events are published only with the
// write, in one unit of work.

import { currentType, type EventData } from '@flagwise/contracts'
import type { Clock, AppRef } from '@flagwise/kernel'
import type { Work } from '@flagwise/platform'

export const ERASURE_DEADLINE_MS = 24 * 3_600_000

export type AnswerStatus = 'erased' | 'nothing_held' | 'retained'

/** One consumer group's part: waiting, its delivery dead-lettered (still waiting), or its answer. */
export interface GroupAnswer {
  readonly status: 'pending' | 'failed' | AnswerStatus
  readonly at: Date | null
  readonly heldItems: number
  readonly reason: string | null
  /** The dead letter's error while failed. */
  readonly error: string | null
}

export interface ErasureRecord {
  readonly id: string
  readonly appRef: AppRef
  readonly subjectExternalId: string
  readonly requestedAt: Date
  readonly deadlineAt: Date
  /** The groups the request reached, once the bus said; null before. */
  readonly expected: readonly string[] | null
  readonly groups: Readonly<Record<string, GroupAnswer>>
  readonly completedAt: Date | null
  readonly heldItems: number
}

export interface ErasureStore {
  find(appRef: AppRef, id: string): Promise<ErasureRecord | null>
  /** The subject's erasure not completed yet, if any. */
  findActive(appRef: AppRef, subjectExternalId: string): Promise<ErasureRecord | null>
  /** Inserts it; false, writing nothing, when the subject already has one in progress. */
  insert(record: ErasureRecord): Promise<boolean>
  /** Saves expected, groups, completedAt and heldItems. */
  save(record: ErasureRecord): Promise<void>
}

export interface PrivacyStores {
  readonly erasures: ErasureStore
}

export interface ErasureDeps {
  readonly clock: Clock
  readonly newErasureId: () => string
}

const FINAL: ReadonlySet<string> = new Set<AnswerStatus>(['erased', 'nothing_held', 'retained'])
const pending = (): GroupAnswer => ({ status: 'pending', at: null, heldItems: 0, reason: null, error: null })

/**
 * Starts erasing a subject, or returns the erasure already in progress for it (`created: false`,
 * nothing published). A new one has a 24 hour deadline and publishes subject.erasure_requested
 * (id `subject.erasure_requested:{erasureId}`, keyed by the erasure, tracked).
 */
export async function startErasure(
  deps: ErasureDeps,
  w: Work<PrivacyStores>,
  input: { readonly appRef: AppRef; readonly subjectExternalId: string },
): Promise<{ erasure: ErasureRecord; created: boolean }> {
  const existing = await w.stores.erasures.findActive(input.appRef, input.subjectExternalId)
  if (existing) return { erasure: existing, created: false }
  const now = deps.clock.now()
  const erasure: ErasureRecord = {
    id: deps.newErasureId(),
    appRef: input.appRef,
    subjectExternalId: input.subjectExternalId,
    requestedAt: now,
    deadlineAt: new Date(now.getTime() + ERASURE_DEADLINE_MS),
    expected: null,
    groups: {},
    completedAt: null,
    heldItems: 0,
  }
  if (!(await w.stores.erasures.insert(erasure))) {
    // Another request for the subject won the race; answer with its erasure.
    const winner = await w.stores.erasures.findActive(input.appRef, input.subjectExternalId)
    if (winner) return { erasure: winner, created: false }
    throw new Error(`No erasure in progress for the subject after a conflict`)
  }
  const data: EventData<'subject.erasure_requested.v1'> = { erasureId: erasure.id, subjectExternalId: erasure.subjectExternalId, occurredAt: now.toISOString() }
  await w.publish({ id: `subject.erasure_requested:${erasure.id}`, type: currentType('subject.erasure_requested'), key: erasure.id, data, track: true })
  return { erasure, created: true }
}

/** What privacy hears about an erasure: the groups the request reached, a dead letter, or an answer. */
export type ErasureNews =
  | { readonly kind: 'reached'; readonly groups: readonly string[] }
  | { readonly kind: 'dead_lettered'; readonly group: string; readonly error: string }
  | { readonly kind: 'answered'; readonly group: string; readonly status: AnswerStatus; readonly heldItems: number; readonly reason: string | null }

/**
 * Applies news to an erasure: `reached` sets the groups to wait for (keeping any answer already
 * in); a dead letter marks a group failed unless it has answered; an answer is kept once per group
 * (a later one for the same group changes nothing). Once every expected group has answered, the
 * erasure completes with the held items summed and publishes erasure.completed (id
 * `erasure.completed:{erasureId}`). A completed erasure, or an unknown one, is left alone.
 */
export async function applyNews(deps: Pick<ErasureDeps, 'clock'>, w: Work<PrivacyStores>, appRef: AppRef, erasureId: string, news: ErasureNews): Promise<void> {
  const erasure = await w.stores.erasures.find(appRef, erasureId)
  if (!erasure || erasure.completedAt) return
  const now = deps.clock.now()
  let groups = erasure.groups
  let expected = erasure.expected
  if (news.kind === 'reached') {
    expected = [...news.groups]
    groups = Object.fromEntries(expected.map((g) => [g, groups[g] ?? pending()]))
  } else if (news.kind === 'dead_lettered') {
    const current = groups[news.group] ?? pending()
    if (FINAL.has(current.status)) return
    groups = { ...groups, [news.group]: { ...current, status: 'failed', error: news.error } }
  } else {
    if (FINAL.has(groups[news.group]?.status ?? '')) return
    groups = { ...groups, [news.group]: { status: news.status, at: now, heldItems: news.heldItems, reason: news.reason, error: null } }
  }
  const done = expected !== null && expected.every((g) => FINAL.has(groups[g]?.status ?? ''))
  const heldItems = done ? expected!.reduce((sum, g) => sum + groups[g]!.heldItems, 0) : 0
  const next: ErasureRecord = { ...erasure, expected, groups, completedAt: done ? now : null, heldItems }
  await w.stores.erasures.save(next)
  if (done) {
    const data: EventData<'erasure.completed.v1'> = { erasureId, subjectExternalId: erasure.subjectExternalId, heldItems, occurredAt: now.toISOString() }
    await w.publish({ id: `erasure.completed:${erasureId}`, type: currentType('erasure.completed'), key: erasureId, data })
  }
}

/** An erasure's status as the API shows it: completed, in progress, or overdue (past its deadline, not completed). */
export function erasureStatus(erasure: ErasureRecord, now: Date): 'completed' | 'in_progress' | 'overdue' {
  if (erasure.completedAt) return 'completed'
  return now.getTime() >= erasure.deadlineAt.getTime() ? 'overdue' : 'in_progress'
}
