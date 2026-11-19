// The erasure saga: privacy coordinates; each module erases its own data and reports back. Failures
// throw ErasureError with a code. Events are published only after the write succeeded.

import type { Clock, TenantRef } from '@flagwise/kernel'

export const ERASURE_MODULES = ['intake', 'cases', 'scoring', 'appeals', 'delivery', 'audit', 'metrics'] as const
export type ErasureModule = (typeof ERASURE_MODULES)[number]

export const ERASURE_DEADLINE_MS = 24 * 3_600_000

export interface ErasureRecord {
  readonly id: string
  readonly tenant: TenantRef
  readonly subjectExternalId: string
  readonly requestedAt: Date
  readonly deadlineAt: Date
  readonly status: 'in_progress' | 'completed'
  readonly acks: Readonly<Partial<Record<ErasureModule, { readonly at: Date; readonly heldItems: number }>>>
  readonly overdueNotified: boolean
  readonly completedAt: Date | null
  readonly version: number
}

export class VersionConflictError extends Error {
  constructor(id: string) {
    super(`Erasure ${id} was changed by someone else`)
    this.name = 'VersionConflictError'
  }
}

export interface ErasureRepository {
  findById(tenant: TenantRef, erasureId: string): Promise<ErasureRecord | null>
  /** The erasure still in progress for this subject, if any. */
  findActive(tenant: TenantRef, subjectExternalId: string): Promise<ErasureRecord | null>
  insert(record: ErasureRecord): Promise<void>
  update(record: ErasureRecord, expectedVersion: number): Promise<void>
}

export type ErasureEvent =
  | {
      readonly type: 'subject.erasure_requested'
      readonly tenant: TenantRef
      readonly erasureId: string
      readonly subjectExternalId: string
      readonly modules: readonly ErasureModule[]
      readonly occurredAt: Date
    }
  | {
      readonly type: 'subject.erased'
      readonly tenant: TenantRef
      readonly erasureId: string
      readonly subjectExternalId: string
      readonly heldItems: number
      readonly occurredAt: Date
    }
  | {
      readonly type: 'erasure.overdue'
      readonly tenant: TenantRef
      readonly erasureId: string
      readonly subjectExternalId: string
      readonly pendingModules: readonly ErasureModule[]
      readonly occurredAt: Date
    }

export interface ErasureDeps {
  readonly erasures: ErasureRepository
  readonly events: { publish(event: ErasureEvent): Promise<void> }
  readonly clock: Clock
  readonly newErasureId: () => string
}

export type ErasureErrorCode = 'not_found' | 'unknown_module' | 'invalid_held_items'

export class ErasureError extends Error {
  readonly code: ErasureErrorCode
  constructor(code: ErasureErrorCode) {
    super(code)
    this.name = 'ErasureError'
    this.code = code
  }
}

/**
 * Starts erasing a subject. When an erasure is already in progress for that subject it is returned
 * with `created: false` and nothing is published. Otherwise a new one is inserted (`deadlineAt` =
 * now + ERASURE_DEADLINE_MS, status 'in_progress', no acks, version 1) and
 * `subject.erasure_requested` is published for every module in ERASURE_MODULES order.
 */
export async function startErasure(
  _deps: ErasureDeps,
  _input: { readonly tenant: TenantRef; readonly subjectExternalId: string },
): Promise<{ erasure: ErasureRecord; created: boolean }> {
  const existing = await _deps.erasures.findActive(_input.tenant, _input.subjectExternalId)
  if (existing) return { erasure: existing, created: false }
  const now = _deps.clock.now()
  const erasure: ErasureRecord = {
    id: _deps.newErasureId(),
    tenant: _input.tenant,
    subjectExternalId: _input.subjectExternalId,
    requestedAt: now,
    deadlineAt: new Date(now.getTime() + ERASURE_DEADLINE_MS),
    status: 'in_progress',
    acks: {},
    overdueNotified: false,
    completedAt: null,
    version: 1,
  }
  await _deps.erasures.insert(erasure)
  await _deps.events.publish({
    type: 'subject.erasure_requested',
    tenant: erasure.tenant,
    erasureId: erasure.id,
    subjectExternalId: erasure.subjectExternalId,
    modules: ERASURE_MODULES,
    occurredAt: now,
  })
  return { erasure, created: true }
}

/**
 * Records that a module finished erasing; `heldItems` is how many items it kept under a legal hold.
 *
 * - 'not_found'; 'unknown_module' (not in ERASURE_MODULES); 'invalid_held_items' (not an integer
 *   >= 0). Checked in that order.
 * - Already completed, or this module already acked: returned unchanged, nothing written or
 *   published.
 * - Otherwise `acks[module] = { at: now, heldItems }`, version + 1. When every module has acked:
 *   status 'completed', `completedAt` now, and after the write `subject.erased` with `heldItems` =
 *   the sum over all acks.
 * - Modules report concurrently: on VersionConflictError read again and start over, at most 3
 *   attempts in total; the third conflict is thrown.
 */
export async function recordModuleErased(
  _deps: ErasureDeps,
  _input: { readonly tenant: TenantRef; readonly erasureId: string; readonly module: string; readonly heldItems: number },
): Promise<ErasureRecord> {
  for (let attempt = 1; ; attempt++) {
    const current = await _deps.erasures.findById(_input.tenant, _input.erasureId)
    if (!current) throw new ErasureError('not_found')
    const module = ERASURE_MODULES.find((m) => m === _input.module)
    if (!module) throw new ErasureError('unknown_module')
    if (!Number.isInteger(_input.heldItems) || _input.heldItems < 0) throw new ErasureError('invalid_held_items')
    if (current.status === 'completed' || current.acks[module]) return current

    const now = _deps.clock.now()
    const acks = { ...current.acks, [module]: { at: now, heldItems: _input.heldItems } }
    const done = ERASURE_MODULES.every((m) => acks[m])
    const next: ErasureRecord = {
      ...current,
      acks,
      status: done ? 'completed' : 'in_progress',
      completedAt: done ? now : null,
      version: current.version + 1,
    }
    try {
      await _deps.erasures.update(next, current.version)
    } catch (err) {
      if (err instanceof VersionConflictError && attempt < 3) continue
      throw err
    }
    if (done) {
      await _deps.events.publish({
        type: 'subject.erased',
        tenant: next.tenant,
        erasureId: next.id,
        subjectExternalId: next.subjectExternalId,
        heldItems: ERASURE_MODULES.reduce((sum, m) => sum + acks[m]!.heldItems, 0),
        occurredAt: now,
      })
    }
    return next
  }
}

/**
 * Asks the modules that have not acked again: publishes `subject.erasure_requested` with only
 * those, in ERASURE_MODULES order, and returns them. Nothing is written; a completed erasure returns
 * [] and publishes nothing. 'not_found' for an unknown erasure.
 */
export async function retryPending(
  _deps: ErasureDeps,
  _input: { readonly tenant: TenantRef; readonly erasureId: string },
): Promise<ErasureModule[]> {
  const erasure = await _deps.erasures.findById(_input.tenant, _input.erasureId)
  if (!erasure) throw new ErasureError('not_found')
  if (erasure.status === 'completed') return []
  const pending = pendingModules(erasure)
  if (pending.length > 0) {
    await _deps.events.publish({
      type: 'subject.erasure_requested',
      tenant: erasure.tenant,
      erasureId: erasure.id,
      subjectExternalId: erasure.subjectExternalId,
      modules: pending,
      occurredAt: _deps.clock.now(),
    })
  }
  return pending
}

/**
 * Raises one alert per erasure once its deadline passes with modules missing: when in progress,
 * `now >= deadlineAt` and not yet notified, sets `overdueNotified` (version + 1), publishes
 * `erasure.overdue` with the pending modules, and returns true. Otherwise false. 'not_found' for an
 * unknown erasure; VersionConflictError is not retried.
 */
export async function checkOverdue(_deps: ErasureDeps, _input: { readonly tenant: TenantRef; readonly erasureId: string }): Promise<boolean> {
  const erasure = await _deps.erasures.findById(_input.tenant, _input.erasureId)
  if (!erasure) throw new ErasureError('not_found')
  const now = _deps.clock.now()
  if (erasure.status !== 'in_progress' || erasure.overdueNotified || now.getTime() < erasure.deadlineAt.getTime()) return false
  await _deps.erasures.update({ ...erasure, overdueNotified: true, version: erasure.version + 1 }, erasure.version)
  await _deps.events.publish({
    type: 'erasure.overdue',
    tenant: erasure.tenant,
    erasureId: erasure.id,
    subjectExternalId: erasure.subjectExternalId,
    pendingModules: pendingModules(erasure),
    occurredAt: now,
  })
  return true
}

function pendingModules(erasure: ErasureRecord): ErasureModule[] {
  return ERASURE_MODULES.filter((m) => !erasure.acks[m])
}
