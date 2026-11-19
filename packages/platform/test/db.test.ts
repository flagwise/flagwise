// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDatabase,
  DatabaseSetupError,
  initDatabase,
  initSingleUser,
  loadMigrations,
  migrate,
  MigrationError,
  pendingMigrations,
  withSystem,
  withTenant,
  type Database,
  type MigrationSet,
} from '../src/index.ts'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../src/testing/pg.ts'

const tenantPolicy = (table: string) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON ${table} TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
`
const sample: MigrationSet = {
  module: 'sample',
  migrations: [
    {
      id: '0001_notes',
      sql: `
CREATE SCHEMA sample;
GRANT USAGE ON SCHEMA sample TO {{app}};
CREATE TABLE sample.notes (id text PRIMARY KEY, app_id text NOT NULL, livemode boolean NOT NULL, body text NOT NULL);
${tenantPolicy('sample.notes')}
`,
    },
  ],
}

/** The Postgres message of a failed query: Drizzle wraps it as the cause of a "Failed query" error. */
const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    const e = err as Error & { cause?: Error }
    return e.cause?.message ?? e.message
  }
  throw new Error('expected a failure')
}

const query = async (url: string, text: string, values: unknown[] = []) => {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query(text, values)).rows
  } finally {
    await client.end()
  }
}

describe('input checks (no database needed)', () => {
  it('initDatabase rejects names that are not identifiers, and duplicate roles', async () => {
    const passwords = { owner: 'x', app: 'x', system: 'x' }
    await expect(initDatabase({ adminUrl: 'postgres://unused', database: 'Bad-Name', passwords })).rejects.toThrow(RangeError)
    await expect(
      initDatabase({ adminUrl: 'postgres://unused', database: 'ok', roles: { owner: 'a', app: 'a', system: 'b' }, passwords }),
    ).rejects.toThrow(RangeError)
    await expect(
      initDatabase({ adminUrl: 'postgres://unused', database: 'ok', passwords, statementTimeoutMs: 0 }),
    ).rejects.toThrow(RangeError)
  })

  it.each([
    ['a module name that is not an identifier', [{ module: 'Bad', migrations: [] }]],
    ['a module listed twice', [{ module: 'a', migrations: [] }, { module: 'a', migrations: [] }]],
    ['an id without a number', [{ module: 'a', migrations: [{ id: 'first', sql: '' }] }]],
    ['ids out of order', [{ module: 'a', migrations: [{ id: '0002_b', sql: '' }, { id: '0001_a', sql: '' }] }]],
    ['a duplicate id', [{ module: 'a', migrations: [{ id: '0001_a', sql: '' }, { id: '0001_a', sql: '' }] }]],
  ])('migrate refuses %s before connecting', async (_label, sets) => {
    await expect(migrate('postgres://unused', sets as MigrationSet[])).rejects.toThrow(MigrationError)
  })

  it('loadMigrations reads NNNN_name.sql files in order and ignores the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-migrations-'))
    writeFileSync(join(dir, '0002_b.sql'), 'SELECT 2;')
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;')
    writeFileSync(join(dir, 'README.md'), 'notes')
    writeFileSync(join(dir, '0003_Bad.sql'), 'SELECT 3;')
    expect(loadMigrations('sample', pathToFileURL(`${dir}/`))).toEqual({
      module: 'sample',
      migrations: [
        { id: '0001_a', sql: 'SELECT 1;' },
        { id: '0002_b', sql: 'SELECT 2;' },
      ],
    })
    expect(() => loadMigrations('sample', pathToFileURL(`${dir}/missing/`))).toThrow(MigrationError)
  })

  it('withTenant rejects ids that cannot be ids, before any query', async () => {
    const db = { app: { transaction: () => Promise.reject(new Error('queried')) } } as unknown as Database
    await expect(withTenant(db, { appIds: ["app'x"], livemode: true }, async () => 1)).rejects.toThrow(RangeError)
    await expect(withTenant(db, { appIds: ['app_a', ''], livemode: true }, async () => 1)).rejects.toThrow(RangeError)
    await expect(withTenant(db, { appIds: ['a'.repeat(65)], livemode: true }, async () => 1)).rejects.toThrow(RangeError)
  })
})

describe.skipIf(!testDatabaseUrl)('initDatabase', () => {
  let t: TestDatabase
  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => t?.drop())

  it('creates login roles without superuser, createdb, createrole or bypassrls', async () => {
    const rows = await query(
      testDatabaseUrl!,
      'SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
      [[t.roles.owner, t.roles.app, t.roles.system]],
    )
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r).toMatchObject({ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false })
  })

  it('sets a statement timeout on the app and system roles', async () => {
    expect((await query(t.appUrl, 'SHOW statement_timeout'))[0]).toEqual({ statement_timeout: '15s' })
    expect((await query(t.systemUrl, 'SHOW statement_timeout'))[0]).toEqual({ statement_timeout: '15s' })
  })

  it('is safe to run again', async () => {
    const url = new URL(t.appUrl)
    await expect(
      initDatabase({ adminUrl: testDatabaseUrl!, database: t.database, roles: t.roles, passwords: { owner: 'o2', app: decodeURIComponent(url.password), system: 's2' } }),
    ).resolves.toBeUndefined()
    expect(await query(t.appUrl, 'SELECT 1 AS ok')).toEqual([{ ok: 1 }])
  })

  it('refuses a user that cannot create roles', async () => {
    const run = initDatabase({ adminUrl: t.appUrl, database: t.database, passwords: { owner: 'x', app: 'x', system: 'x' } })
    await expect(run).rejects.toThrow(/cannot|single database user/)
  })
})

describe.skipIf(!testDatabaseUrl)('migrate', () => {
  let t: TestDatabase
  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => t?.drop())

  it('applies platform first, then each set once', async () => {
    expect(await migrate(t.ownerUrl, [sample], t.roles)).toEqual(['platform/0001_tenant_context', 'platform/0002_event_bus', 'platform/0003_event_origin', 'platform/0004_idempotency_keys', 'platform/0005_event_contracts', 'platform/0006_tracked_events_and_retention', 'sample/0001_notes'])
    expect(await migrate(t.ownerUrl, [sample], t.roles)).toEqual([])
  })

  it('refuses a migration that changed after it was applied', async () => {
    const changed = { module: 'sample', migrations: [{ id: '0001_notes', sql: `${sample.migrations[0]!.sql}\n-- edited` }] }
    await expect(migrate(t.ownerUrl, [changed], t.roles)).rejects.toThrow(/changed after it was applied/)
  })

  it('refuses when an applied migration is missing', async () => {
    await expect(migrate(t.ownerUrl, [], t.roles)).rejects.toThrow(/sample\/0001_notes is missing/)
  })

  it('rolls back a failing migration and keeps the ones before it', async () => {
    const more: MigrationSet = {
      module: 'sample',
      migrations: [
        ...sample.migrations,
        { id: '0002_tags', sql: 'CREATE TABLE sample.tags (id text PRIMARY KEY);' },
        { id: '0003_broken', sql: 'CREATE TABLE sample.half (id text); SELECT no_such_function();' },
      ],
    }
    await expect(migrate(t.ownerUrl, [more], t.roles)).rejects.toThrow(/sample\/0003_broken failed/)
    const tables = await query(t.ownerUrl, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'sample' ORDER BY 1")
    expect(tables.map((r) => r.table_name)).toEqual(['notes', 'tags'])
  })

  it('refuses an unknown placeholder', async () => {
    const fresh = await createTestDatabase()
    try {
      const bad: MigrationSet = { module: 'other', migrations: [{ id: '0001_x', sql: 'GRANT USAGE ON SCHEMA platform TO {{nobody}};' }] }
      await expect(migrate(fresh.ownerUrl, [bad], fresh.roles)).rejects.toThrow(/Unknown placeholder \{\{nobody\}\}/)
    } finally {
      await fresh.drop()
    }
  })

  it('lets concurrent runs take turns', async () => {
    const extra: MigrationSet = { module: 'extra', migrations: [{ id: '0001_a', sql: 'CREATE SCHEMA extra;' }] }
    const tags = { module: 'sample', migrations: [...sample.migrations, { id: '0002_tags', sql: 'CREATE TABLE sample.tags (id text PRIMARY KEY);' }] }
    const [a, b] = await Promise.all([migrate(t.ownerUrl, [tags, extra], t.roles), migrate(t.ownerUrl, [tags, extra], t.roles)])
    expect([...a, ...b]).toEqual(['extra/0001_a'])
  })

  it('keeps the migration table away from the app role', async () => {
    await expect(query(t.appUrl, 'SELECT * FROM platform.schema_migrations')).rejects.toThrow(/permission denied/)
  })
})

describe.skipIf(!testDatabaseUrl)('withTenant', () => {
  let t: TestDatabase
  let db: Database
  const A = { appIds: ['app_a1'], livemode: true }
  const insert = (id: string, app: string, live: boolean) =>
    sql`INSERT INTO sample.notes (id, app_id, livemode, body) VALUES (${id}, ${app}, ${live}, 'Jane Doe was rude')`
  const ids = async (scope: typeof A) =>
    withTenant(db, scope, async (tx) => (await tx.execute<{ id: string }>(sql`SELECT id FROM sample.notes ORDER BY id`)).rows.map((r) => r.id))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [sample], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl, max: 1 })
    await withTenant(db, A, async (tx) => {
      await tx.execute(insert('n1', 'app_a1', true))
    })
    await withTenant(db, { appIds: ['app_a2'], livemode: true }, async (tx) => {
      await tx.execute(insert('n2', 'app_a2', true))
    })
    await withTenant(db, { appIds: ['app_a1'], livemode: false }, async (tx) => {
      await tx.execute(insert('n3', 'app_a1', false))
    })
    await withTenant(db, { appIds: ['app_b1'], livemode: true }, async (tx) => {
      await tx.execute(insert('n4', 'app_b1', true))
    })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('shows only rows of the scope', async () => {
    expect(await ids(A)).toEqual(['n1'])
    expect(await ids({ appIds: ['app_a1', 'app_a2'], livemode: true })).toEqual(['n1', 'n2'])
    expect(await ids({ appIds: ['app_a1'], livemode: false })).toEqual(['n3'])
    expect(await ids({ appIds: ['app_b1'], livemode: true })).toEqual(['n4'])
    expect(await ids({ appIds: [], livemode: true })).toEqual([])
  })

  it('shows nothing without a context, and refuses to write', async () => {
    expect((await db.app.execute(sql`SELECT id FROM sample.notes`)).rows).toEqual([])
    expect(await failure(db.app.execute(insert('n9', 'app_a1', true)))).toMatch(/row-level security/)
  })

  it('refuses to write a row of another tenant', async () => {
    expect(await failure(withTenant(db, A, async (tx) => tx.execute(insert('n9', 'app_b1', true))))).toMatch(/row-level security/)
    expect(await failure(withTenant(db, A, async (tx) => tx.execute(insert('n9', 'app_a1', false))))).toMatch(/row-level security/)
  })

  it('does not carry the context into the next use of the connection', async () => {
    await ids(A)
    const after = await db.app.execute<{ apps: string[] | null }>(sql`SELECT platform.app_ids() AS apps`)
    expect(after.rows).toEqual([{ apps: null }])
  })

  it('rolls back when the function throws, and rethrows', async () => {
    const boom = new Error('boom')
    await expect(
      withTenant(db, A, async (tx) => {
        await tx.execute(insert('n5', 'app_a1', true))
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(await ids(A)).toEqual(['n1'])
  })

  it('returns what the function returns', async () => {
    expect(await withTenant(db, A, async () => 42)).toBe(42)
  })

  it('gives the system role no access to tenant tables', async () => {
    expect(await failure(withSystem(db, async (tx) => tx.execute(sql`SELECT id FROM sample.notes`)))).toMatch(/permission denied/)
  })
})

describe.skipIf(!testDatabaseUrl)('one database URL', () => {
  // Like a managed Postgres: the URL's user owns the database and can create roles, but is no superuser.
  const suffix = randomBytes(5).toString('hex')
  const database = `fw_test_${suffix}`
  const user = `fwt_${suffix}_single`
  const roles = { owner: user, app: `fwt_${suffix}_app`, system: `fwt_${suffix}_system` }
  const url = (() => {
    const u = new URL(testDatabaseUrl ?? 'postgres://x@localhost/x')
    u.username = user
    u.password = 'jane-doe-secret'
    u.pathname = `/${database}`
    return u.toString()
  })()
  let db: Database
  const A = { appIds: ['app_a1'], livemode: true }
  const insert = (id: string, app: string) =>
    sql`INSERT INTO sample.notes (id, app_id, livemode, body) VALUES (${id}, ${app}, true, 'John Doe was rude')`

  beforeAll(async () => {
    await query(testDatabaseUrl!, `CREATE ROLE "${user}" LOGIN CREATEROLE PASSWORD 'jane-doe-secret'`)
    await query(testDatabaseUrl!, `CREATE DATABASE "${database}" OWNER "${user}"`)
    await initSingleUser(url, roles)
    await initSingleUser(url, roles)
    await migrate(url, [sample], roles)
    db = createDatabase({ appUrl: url, systemUrl: url, max: 1, assumeRoles: roles })
    await withTenant(db, A, async (tx) => tx.execute(insert('n1', 'app_a1')))
    await withTenant(db, { appIds: ['app_b1'], livemode: true }, async (tx) => tx.execute(insert('n2', 'app_b1')))
  })
  afterAll(async () => {
    await db?.close()
    await query(testDatabaseUrl!, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    for (const role of [roles.app, roles.system, user]) await query(testDatabaseUrl!, `DROP ROLE IF EXISTS "${role}"`)
  })

  it('creates the app and system roles without login or bypassrls', async () => {
    const rows = await query(testDatabaseUrl!, 'SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)', [[roles.app, roles.system]])
    expect(rows).toEqual([
      { rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolcanlogin: false, rolsuper: false, rolbypassrls: false },
    ])
  })

  it('runs each pool as its role, with a statement timeout, even after RESET ROLE', async () => {
    expect((await db.app.execute(sql`SELECT current_user AS u, current_setting('statement_timeout') AS t`)).rows).toEqual([{ u: roles.app, t: '15s' }])
    expect((await db.system.execute(sql`SELECT current_user AS u`)).rows).toEqual([{ u: roles.system }])
    await db.app.execute(sql`RESET ROLE`)
    expect((await db.app.execute(sql`SELECT current_user AS u`)).rows).toEqual([{ u: roles.app }])
  })

  it('keeps tenants apart as with separate role URLs', async () => {
    const ids = await withTenant(db, A, async (tx) => (await tx.execute<{ id: string }>(sql`SELECT id FROM sample.notes ORDER BY id`)).rows.map((r) => r.id))
    expect(ids).toEqual(['n1'])
    expect((await db.app.execute(sql`SELECT id FROM sample.notes`)).rows).toEqual([])
    expect(await failure(withTenant(db, A, async (tx) => tx.execute(insert('n9', 'app_b1'))))).toMatch(/row-level security/)
    expect(await failure(withSystem(db, async (tx) => tx.execute(sql`SELECT id FROM sample.notes`)))).toMatch(/permission denied/)
  })

  it('does not open a connection whose role it cannot take', async () => {
    const other = createDatabase({ appUrl: url, systemUrl: url, max: 1, assumeRoles: { app: 'pg_read_server_files', system: roles.system } })
    try {
      await expect(other.app.execute(sql`SELECT 1`)).rejects.toThrow()
    } finally {
      await other.close()
    }
  })
})

describe.skipIf(!testDatabaseUrl)('initSingleUser refusals', () => {
  let t: TestDatabase
  beforeAll(async () => {
    t = await createTestDatabase()
  })
  afterAll(async () => t?.drop())

  it('refuses the app or system role as the URL user', async () => {
    await expect(initSingleUser(t.appUrl, t.roles)).rejects.toThrow(DatabaseSetupError)
    await expect(initSingleUser(t.appUrl, t.roles)).rejects.toThrow('must be the user that owns the tables')
  })

  it('refuses missing roles when the user cannot create roles', async () => {
    const run = initSingleUser(t.ownerUrl, { app: `${t.roles.app}_x`, system: `${t.roles.system}_x` })
    await expect(run).rejects.toThrow(/cannot create roles/)
  })

  it('refuses a role that bypasses row-level security', async () => {
    const name = `${t.roles.app}_bypass`
    await query(testDatabaseUrl!, `CREATE ROLE "${name}" NOLOGIN BYPASSRLS`)
    try {
      await expect(initSingleUser(t.ownerUrl, { app: name, system: t.roles.system })).rejects.toThrow(/bypasses row-level security/)
    } finally {
      await query(testDatabaseUrl!, `DROP ROLE "${name}"`)
    }
  })

  it('refuses a role the user can neither use nor grant itself', async () => {
    await expect(initSingleUser(t.ownerUrl, t.roles)).rejects.toThrow(/cannot switch to role/)
  })
})

describe.skipIf(!testDatabaseUrl)('pendingMigrations', () => {
  let t: TestDatabase
  let db: Database
  beforeAll(async () => {
    t = await createTestDatabase()
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl, max: 1 })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('lists every migration before the first run, none after, and ignores applied ones not given', async () => {
    const all = ['platform/0001_tenant_context', 'platform/0002_event_bus', 'platform/0003_event_origin', 'platform/0004_idempotency_keys', 'platform/0005_event_contracts', 'platform/0006_tracked_events_and_retention', 'sample/0001_notes']
    expect(await pendingMigrations(db, [sample])).toEqual(all)
    // A migration job between creating the schema and granting it: still everything, not an error.
    const owner = new pg.Client({ connectionString: t.ownerUrl })
    await owner.connect()
    await owner.query('CREATE SCHEMA platform; CREATE TABLE platform.schema_migrations (module text, id text)')
    expect(await pendingMigrations(db, [sample])).toEqual(all)
    await owner.query('DROP SCHEMA platform CASCADE')
    await owner.end()
    await migrate(t.ownerUrl, [sample], t.roles)
    expect(await pendingMigrations(db, [sample])).toEqual([])
    expect(await pendingMigrations(db, [])).toEqual([])
    const more = { module: 'sample', migrations: [...sample.migrations, { id: '0002_more', sql: 'SELECT 1;' }] }
    expect(await pendingMigrations(db, [more])).toEqual(['sample/0002_more'])
  })
})
