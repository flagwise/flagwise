// Erasures on Postgres, inside a tenant transaction (row-level security limits it to its
// apps and the mode).

import type { Clock } from '@flagwise/kernel'
import { loadMigrations, pgUnitOfWork, type Database, type EventBus, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, eq, isNull } from 'drizzle-orm'
import type { ErasureRecord, ErasureStore, GroupAnswer } from '../app/erasure.ts'
import type { PrivacyServiceDeps } from '../app/handlers.ts'
import { erasuresTable as erasures } from './schema.ts'

export const privacyMigrations: MigrationSet = loadMigrations('privacy', new URL('./migrations/', import.meta.url))

type StoredAnswer = Omit<GroupAnswer, 'at'> & { readonly at: string | null }

const toRecord = (r: typeof erasures.$inferSelect): ErasureRecord => ({
  id: r.id,
  tenant: { appId: r.appId, livemode: r.livemode },
  subjectExternalId: r.subjectExternalId,
  requestedAt: r.requestedAt,
  deadlineAt: r.deadlineAt,
  expected: r.expected,
  groups: Object.fromEntries(Object.entries(r.groups as Record<string, StoredAnswer>).map(([g, a]) => [g, { ...a, at: a.at === null ? null : new Date(a.at) }])),
  completedAt: r.completedAt,
  heldItems: r.heldItems,
})

export function pgErasureStore(tx: TenantTx): ErasureStore {
  return {
    async find(tenant, id) {
      const [row] = await tx
        .select()
        .from(erasures)
        .where(and(eq(erasures.appId, tenant.appId), eq(erasures.livemode, tenant.livemode), eq(erasures.id, id)))
      return row ? toRecord(row) : null
    },
    async findActive(tenant, subjectExternalId) {
      const [row] = await tx
        .select()
        .from(erasures)
        .where(
          and(
            
            eq(erasures.appId, tenant.appId),
            eq(erasures.livemode, tenant.livemode),
            eq(erasures.subjectExternalId, subjectExternalId),
            isNull(erasures.completedAt),
          ),
        )
      return row ? toRecord(row) : null
    },
    async insert(r) {
      const rows = await tx
        .insert(erasures)
        .values({
          appId: r.tenant.appId,
          livemode: r.tenant.livemode,
          id: r.id,
          subjectExternalId: r.subjectExternalId,
          requestedAt: r.requestedAt,
          deadlineAt: r.deadlineAt,
          expected: r.expected === null ? null : [...r.expected],
          groups: r.groups,
          completedAt: r.completedAt,
          heldItems: r.heldItems,
        })
        .onConflictDoNothing()
        .returning({ id: erasures.id })
      return rows.length > 0
    },
    async save(r) {
      await tx
        .update(erasures)
        .set({ expected: r.expected === null ? null : [...r.expected], groups: r.groups, completedAt: r.completedAt, heldItems: r.heldItems })
        .where(and(eq(erasures.appId, r.tenant.appId), eq(erasures.livemode, r.tenant.livemode), eq(erasures.id, r.id)))
    },
  }
}

export function pgPrivacyDeps(db: Database, bus: EventBus, options: { readonly clock: Clock; readonly newErasureId: () => string }): PrivacyServiceDeps {
  return { ...options, uow: pgUnitOfWork(db, bus, (tx) => ({ erasures: pgErasureStore(tx) })) }
}
