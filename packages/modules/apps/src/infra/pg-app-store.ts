// The apps registry on Postgres, inside an app transaction (row-level security limits it to its apps).

import { loadMigrations, type AppTx, type MigrationSet } from '@flagwise/platform'
import { eq } from 'drizzle-orm'
import type { AppStore } from '../app/registry.ts'
import { appsTable as apps } from './schema.ts'

export const appsMigrations: MigrationSet = loadMigrations('apps', new URL('./migrations/', import.meta.url))

/** An AppStore on the given app transaction. */
export function pgAppStore(tx: AppTx): AppStore {
  return {
    async insertApp(app) {
      await tx.insert(apps).values(app)
    },

    async findApp(appId) {
      const [row] = await tx.select().from(apps).where(eq(apps.id, appId))
      return row ?? null
    },

    async setDeletedAt(appId, deletedAt) {
      await tx.update(apps).set({ deletedAt }).where(eq(apps.id, appId))
    },
  }
}
