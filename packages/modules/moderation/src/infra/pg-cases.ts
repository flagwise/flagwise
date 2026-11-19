// Moderation on Postgres: its use cases and handlers on its own tables and policy copy, each run in
// a tenant transaction of its own, and the read side of its routes.

import type { TenantRef } from '@flagwise/kernel'
import { pgUnitOfWork, scopeOfRef, withTenant, type Database, type EventBus } from '@flagwise/platform'
import type { CaseReader } from '../app/ports.ts'
import type { ModerationServiceDeps } from '../app/service.ts'
import { pgCaseRepository } from './pg-case-repository.ts'
import { pgModerationPolicyCopy } from './pg-policy-copy.ts'

export type PgModerationOptions = Omit<ModerationServiceDeps, 'uow' | 'policy'>

export function pgModerationDeps(db: Database, bus: EventBus, options: PgModerationOptions): ModerationServiceDeps {
  return { ...options, uow: pgUnitOfWork(db, bus, (tx) => ({ cases: pgCaseRepository(tx) })), policy: pgModerationPolicyCopy(db) }
}

/** Runs `fn` with the case reader in a tenant transaction. */
export function pgCaseReads(db: Database): <T>(tenant: TenantRef, fn: (cases: CaseReader) => Promise<T>) => Promise<T> {
  return (tenant, fn) => withTenant(db, scopeOfRef(tenant), (tx) => fn(pgCaseRepository(tx)))
}
