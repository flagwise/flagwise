// Notifications on Postgres, inside an app transaction (row-level security limits it to its apps
// and the mode).

import type { AppRef, Clock } from '@flagwise/kernel'
import { loadMigrations, pgUnitOfWork, type AppTx, type Database, type EventBus, type MigrationSet } from '@flagwise/platform'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { NotificationRecord, NotificationState } from '../domain/lifecycle.ts'
import type { NotificationStore, NotificationsServiceDeps } from '../app/service.ts'
import { notificationsTable as n } from './schema.ts'

export const notificationsMigrations: MigrationSet = loadMigrations('notifications', new URL('./migrations/', import.meta.url))

const toRecord = (r: typeof n.$inferSelect): NotificationRecord => ({
  id: r.id,
  appRef: { appId: r.appId, livemode: r.livemode },
  key: r.key,
  type: r.type as NotificationRecord['type'],
  values: r.values as Record<string, string>,
  state: r.state as NotificationState,
  raisedAt: r.raisedAt,
  acknowledgedAt: r.acknowledgedAt,
  resolvedAt: r.resolvedAt,
  resolvedBy: r.resolvedBy,
})

const ofApp = (appRef: AppRef) => and(eq(n.appId, appRef.appId), eq(n.livemode, appRef.livemode))

export function pgNotificationStore(tx: AppTx): NotificationStore {
  return {
    async findByKey(appRef, key) {
      const [row] = await tx.select().from(n).where(and(ofApp(appRef), eq(n.key, key)))
      return row ? toRecord(row) : null
    },
    async findById(appRef, id) {
      const [row] = await tx.select().from(n).where(and(ofApp(appRef), eq(n.id, id)))
      return row ? toRecord(row) : null
    },
    async lockKey(appRef, key) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`notifications|${appRef.appId}|${appRef.livemode}|${key}`}, 0))`)
    },
    async save(r) {
      const row = {
        appId: r.appRef.appId,
        livemode: r.appRef.livemode,
        key: r.key,
        id: r.id,
        type: r.type,
        values: r.values,
        state: r.state,
        raisedAt: r.raisedAt,
        acknowledgedAt: r.acknowledgedAt,
        resolvedAt: r.resolvedAt,
        resolvedBy: r.resolvedBy,
      }
      const { appId: _a, livemode: _l, key: _k, ...changes } = row
      await tx.insert(n).values(row).onConflictDoUpdate({ target: [n.appId, n.livemode, n.key], set: changes })
    },
    async list(appRef, states, limit) {
      const rows = await tx
        .select()
        .from(n)
        .where(and(ofApp(appRef), inArray(n.state, [...states]), isNotNull(n.raisedAt)))
        .orderBy(desc(n.raisedAt), desc(n.id))
        .limit(limit)
      return rows.map(toRecord)
    },
  }
}

export function pgNotificationsDeps(db: Database, bus: EventBus, options: { readonly clock: Clock; readonly newNotificationId: () => string }): NotificationsServiceDeps {
  return { ...options, uow: pgUnitOfWork(db, bus, (tx) => ({ notifications: pgNotificationStore(tx) })) }
}

