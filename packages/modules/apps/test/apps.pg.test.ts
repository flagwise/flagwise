// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type ManualClock } from '@flagwise/kernel'
import { createDatabase, migrate, withApps, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appsMigrations, appsTables, createApp, deleteApp, pgAppStore, restoreApp, type AppDeps, type AppEvent } from '../src/index.ts'

const DAY = 86_400_000

describe.skipIf(!testDatabaseUrl)('apps on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let clock: ManualClock
  const seen: AppEvent[] = []
  /** An app transaction for the listed apps, with the apps deps on it. */
  const asApps = <R>(appIds: string[], fn: (deps: AppDeps) => Promise<R>) =>
    withApps(db, { appIds, livemode: true }, (tx) => fn({ store: pgAppStore(tx), clock, newAppId: () => 'app_new', events: { publish: async (e) => void seen.push(e) } }))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [appsMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    clock = manualClock('2026-11-20T09:00:00Z')
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, appsTables)).toEqual([])
  })

  it('creates, deletes and restores an app, publishing each change once', async () => {
    seen.length = 0
    const created = await asApps(['app_a'], (d) => createApp(d, { id: 'app_a', name: '  Jane Doe Dating iOS ' }))
    expect(created).toEqual({ id: 'app_a', name: 'Jane Doe Dating iOS', createdAt: clock.now(), deletedAt: null })
    const deletedAt = clock.now()
    expect((await asApps(['app_a'], (d) => deleteApp(d, 'app_a'))).deletedAt).toEqual(deletedAt)
    clock.advance(DAY)
    // Deleting again changes nothing and publishes nothing.
    expect((await asApps(['app_a'], (d) => deleteApp(d, 'app_a'))).deletedAt).toEqual(deletedAt)
    expect((await asApps(['app_a'], (d) => restoreApp(d, 'app_a'))).deletedAt).toBeNull()
    expect(await asApps(['app_a'], (d) => d.store.findApp('app_a'))).toMatchObject({ deletedAt: null })
    expect(seen).toEqual([
      { type: 'app.created', appId: 'app_a', name: 'Jane Doe Dating iOS', occurredAt: deletedAt },
      { type: 'app.deletion_requested', appId: 'app_a', purgeAt: new Date(deletedAt.getTime() + 30 * DAY), occurredAt: deletedAt },
      { type: 'app.restored', appId: 'app_a', occurredAt: clock.now() },
    ])
  })

  it('restores only within the grace period', async () => {
    await asApps(['app_b'], (d) => createApp(d, { id: 'app_b', name: 'John Doe Market' }))
    await asApps(['app_b'], (d) => deleteApp(d, 'app_b'))
    clock.advance(30 * DAY)
    await expect(asApps(['app_b'], (d) => restoreApp(d, 'app_b'))).rejects.toThrow('past its grace period')
  })

  it('refuses empty names and keeps apps apart', async () => {
    await expect(asApps(['app_new'], (d) => createApp(d, { name: '  ' }))).rejects.toThrow('name')
    expect(await asApps(['app_b'], (d) => d.store.findApp('app_a'))).toBeNull()
    await expect(asApps(['app_b'], (d) => deleteApp(d, 'app_a'))).rejects.toThrow('No app app_a')
    // Nor create an app outside the apps it may see.
    await expect(asApps(['app_a'], (d) => createApp(d, { id: 'app_sneaky', name: 'Sneaky' }))).rejects.toThrow()
  })
})
