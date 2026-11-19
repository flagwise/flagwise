// A service's copy of a document another service owns and publishes whole on every change, such as
// an app's policy: one row per app and mode, kept from the owner's events, never written by hand.
// Events of one app can arrive out of order, so a copy only moves forward: an older version than
// the one kept is ignored.

import type { AppRef } from '@flagwise/kernel'
import { and, eq, sql } from 'drizzle-orm'
import { boolean, integer, jsonb, text, type PgSchema } from 'drizzle-orm/pg-core'
import type { EventBus } from '../bus/memory-bus.ts'
import { appOf } from '../bus/unit-of-work.ts'
import { scopeOfApp, withApps, type Database } from './database.ts'

/**
 * The copy table `name` in a service's schema. Its migration creates it with the primary key
 * (app_id, livemode), `version integer NOT NULL CHECK (version >= 1)` and tenant
 * row-level security.
 */
export function copyTable(schema: PgSchema, name: string) {
  return schema.table(name, {
    appId: text('app_id').notNull(),
    livemode: boolean('livemode').notNull(),
    version: integer('version').notNull(),
    document: jsonb('document').notNull(),
  })
}

export type CopyTable = ReturnType<typeof copyTable>

export interface KeptCopy<T> {
  readonly version: number
  readonly document: T
}

export interface DocumentCopy<T> {
  /** The copy kept for the app and mode, or null before its first event. */
  get(appRef: AppRef): Promise<KeptCopy<T> | null>
  /** Keeps `document` as of `version`; false, writing nothing, when the copy is already at it or later. */
  keep(appRef: AppRef, version: number, document: T): Promise<boolean>
}

/** The copy in `table`, each call in its own app transaction. */
export function pgDocumentCopy<T>(db: Database, table: CopyTable): DocumentCopy<T> {
  return {
    async get(appRef) {
      const [row] = await withApps(db, scopeOfApp(appRef), (tx) =>
        tx
          .select({ version: table.version, document: table.document })
          .from(table)
          .where(and(eq(table.appId, appRef.appId), eq(table.livemode, appRef.livemode))),
      )
      return row ? { version: row.version, document: row.document as T } : null
    },

    async keep(appRef, version, document) {
      const rows = await withApps(db, scopeOfApp(appRef), (tx) =>
        tx
          .insert(table)
          .values({ appId: appRef.appId, livemode: appRef.livemode, version, document })
          .onConflictDoUpdate({
            target: [table.appId, table.livemode],
            set: { version, document },
            setWhere: sql`${table.version} < excluded.version`,
          })
          .returning({ version: table.version }),
      )
      return rows.length > 0
    },
  }
}

/** A copy in memory, for tests and dev. */
export function memoryDocumentCopy<T>(): DocumentCopy<T> & { readonly kept: Map<string, KeptCopy<T>> } {
  const kept = new Map<string, KeptCopy<T>>()
  const k = (t: AppRef) => `${t.appId}|${t.livemode}`
  return {
    kept,
    async get(appRef) {
      return kept.get(k(appRef)) ?? null
    },
    async keep(appRef, version, document) {
      const current = kept.get(k(appRef))
      if (current && current.version >= version) return false
      kept.set(k(appRef), { version, document: structuredClone(document) })
      return true
    },
  }
}

/**
 * Subscribes `group` to `type`, the owner's event that carries the whole document: each delivery
 * keeps the document as of its version in `copy` (`of` reads both from the event's data). Subscribe
 * it before the service's groups that read the copy, so a drain or poll brings the copy up to date
 * first.
 */
export function subscribeCopy<T>(bus: EventBus, group: string, type: string, copy: DocumentCopy<T>, of: (data: unknown) => KeptCopy<T>): void {
  bus.subscribe(group, [type], async (event) => {
    const { version, document } = of(event.data)
    await copy.keep(appOf(event), version, document)
  })
}
