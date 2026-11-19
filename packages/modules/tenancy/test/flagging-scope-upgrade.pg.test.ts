// Upgrading to the flagging scope: a key issued with the ingest scope before keeps working, with
// flagging in its place. Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock } from '@flagwise/kernel'
import { createDatabase, migrate, withSystem, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, generateApiKey, pgKeyDirectory, pgTenancyStore, resolveApiKey, tenancyMigrations } from '../src/index.ts'

describe.skipIf(!testDatabaseUrl)('upgrading to the flagging scope', () => {
  let t: TestDatabase
  let db: Database
  const clock = manualClock('2026-11-19T09:00:00Z')

  beforeAll(async () => {
    t = await createTestDatabase()
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('turns the ingest scope of an existing key into flagging, and refuses ingest afterwards', async () => {
    // A release before: keys could hold the ingest scope.
    await migrate(t.ownerUrl, [{ ...tenancyMigrations, migrations: tenancyMigrations.migrations.slice(0, 3) }], t.roles)
    const old = generateApiKey(true)
    await withTenant(db, { appIds: ['app_jane'], livemode: true }, async (tx) => {
      const deps = { store: pgTenancyStore(tx), clock, newId: (p: string) => `${p}_1` }
      await createApp(deps, { id: 'app_jane', name: 'Jane Doe Dating iOS' })
      await tx.execute(sql`INSERT INTO tenancy.api_keys (app_id, id, livemode, lookup, hash, scopes, created_at)
        VALUES ('app_jane', 'key_old', true, ${old.lookup}, ${old.hash}, ARRAY['ingest', 'actions'], ${clock.now().toISOString()})`)
    })

    await migrate(t.ownerUrl, [tenancyMigrations], t.roles)
    const resolved = await withSystem(db, (tx) => resolveApiKey(pgKeyDirectory(tx), old.key, clock.now()))
    expect(resolved).toMatchObject({ ok: true, context: { actor: { type: 'api_key', id: 'key_old', scopes: ['flagging', 'actions'] } } })
    await expect(
      withTenant(db, { appIds: ['app_jane'], livemode: true }, (tx) =>
        tx.execute(sql`UPDATE tenancy.api_keys SET scopes = ARRAY['ingest'] WHERE id = 'key_old'`),
      ),
    ).rejects.toThrow()
  })
})
