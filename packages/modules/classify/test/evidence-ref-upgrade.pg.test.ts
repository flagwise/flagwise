// Upgrading to evidence refs: the screenings classify kept before report.received carried one take
// the place flagging wrote every snapshot to then. Runs against a real Postgres through
// TEST_DATABASE_URL; skipped without it.
import type { TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfRef, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyMigrations, pgClassificationStore } from '../src/index.ts'

const A: TenantRef = { orgId: 'org_jane', appId: 'app_jane', livemode: true }

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
    await withTenant(db, scopeOfRef(A), (tx) =>
      tx.execute(sql`INSERT INTO classify.report_screenings (org_id, app_id, livemode, report_id, p0_signals, injection_suspected, reported_external_id)
        VALUES ('org_jane', 'app_jane', true, 'rpt_1', ARRAY[]::text[], false, 'u_john_doe')`),
    )
    await migrate(t.ownerUrl, [classifyMigrations], t.roles)
    const screening = await withTenant(db, scopeOfRef(A), (tx) => pgClassificationStore(tx).findScreening(A, 'rpt_1'))
    expect(screening).toMatchObject({ reportId: 'rpt_1', evidenceRef: 'apps/app_jane/rpt_1', reportedExternalId: 'u_john_doe' })
  })
})
