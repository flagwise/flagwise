// Upgrading to evidence refs: the screenings classify kept before report.received carried one take
// the place flagging wrote every snapshot to then. Runs against a real Postgres through
// TEST_DATABASE_URL; skipped without it.
import type { AppRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfApp, withApps, type Database } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyMigrations, pgClassificationStore } from '../src/index.ts'

const A: AppRef = { appId: 'app_jane', livemode: true }

describe.skipIf(!testDatabaseUrl)('upgrading to evidence refs', () => {
  let t: TestDatabase
  let db: Database

  beforeAll(async () => {
    t = await createTestDatabase()
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('gives each screening kept before the place of its snapshot', async () => {
    // A release before: screenings without a ref.
    await migrate(t.ownerUrl, [{ ...classifyMigrations, migrations: classifyMigrations.migrations.slice(0, 4) }], t.roles)
    await withApps(db, scopeOfApp(A), (tx) =>
      tx.execute(sql`INSERT INTO classify.report_screenings (app_id, livemode, report_id, p0_signals, injection_suspected, reported_external_id)
        VALUES ('app_jane', true, 'rpt_1', ARRAY[]::text[], false, 'u_john_doe')`),
    )
    await migrate(t.ownerUrl, [classifyMigrations], t.roles)
    const screening = await withApps(db, scopeOfApp(A), (tx) => pgClassificationStore(tx).findScreening(A, 'rpt_1'))
    expect(screening).toMatchObject({ reportId: 'rpt_1', evidenceRef: 'apps/app_jane/rpt_1', reportedExternalId: 'u_john_doe' })
  })
})
