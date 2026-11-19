// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import type { TenantRef } from '@flagwise/kernel'
import { pgSchema } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyTable, createDatabase, migrate, pgDocumentCopy, type Database, type DocumentCopy, type MigrationSet } from '../src/index.ts'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../src/testing/pg.ts'
import { schemaDrift } from '../src/testing/schema.ts'

const table = copyTable(pgSchema('sample'), 'policy_copies')
const sample: MigrationSet = {
  module: 'sample',
  migrations: [
    {
      id: '0001_policy_copies',
      sql: `
CREATE SCHEMA sample;
GRANT USAGE ON SCHEMA sample TO {{app}};
CREATE TABLE sample.policy_copies (
  org_id text NOT NULL, app_id text NOT NULL, livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1), document jsonb NOT NULL,
  PRIMARY KEY (org_id, app_id, livemode)
);
ALTER TABLE sample.policy_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.policy_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON sample.policy_copies TO {{app}}
  USING (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
`,
    },
  ],
}

const LIVE: TenantRef = { orgId: 'org_jane', appId: 'app_a', livemode: true }
const TEST: TenantRef = { ...LIVE, livemode: false }

describe.skipIf(!testDatabaseUrl)('a document copy on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let copy: DocumentCopy<{ readonly rules: readonly string[] }>

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [sample], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    copy = pgDocumentCopy(db, table)
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('matches its migration', async () => {
    expect(await schemaDrift(t.ownerUrl, [table])).toEqual([])
  })

  it('is null before the first event, then keeps each newer version', async () => {
    expect(await copy.get(LIVE)).toBeNull()
    expect(await copy.keep(LIVE, 1, { rules: ['a'] })).toBe(true)
    expect(await copy.keep(LIVE, 3, { rules: ['c'] })).toBe(true)
    expect(await copy.get(LIVE)).toEqual({ version: 3, document: { rules: ['c'] } })
  })

  it('ignores a version it already has or one older, as events of one app may come out of order', async () => {
    expect(await copy.keep(LIVE, 2, { rules: ['b'] })).toBe(false)
    expect(await copy.keep(LIVE, 3, { rules: ['other'] })).toBe(false)
    expect(await copy.get(LIVE)).toEqual({ version: 3, document: { rules: ['c'] } })
  })

  it('keeps one copy per mode', async () => {
    expect(await copy.get(TEST)).toBeNull()
    await copy.keep(TEST, 1, { rules: ['test'] })
    expect(await copy.get(TEST)).toEqual({ version: 1, document: { rules: ['test'] } })
    expect((await copy.get(LIVE))?.version).toBe(3)
  })
})
