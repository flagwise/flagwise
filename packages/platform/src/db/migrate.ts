// Plain SQL migrations, one set per module, applied by the owner role. Each module owns a Postgres
// schema named after it; its migrations create the tables, row-level security policies and grants.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { DEFAULT_ROLES, type DbRoleNames } from './init.ts'
import type { Database } from './database.ts'

export interface Migration {
  /** `NNNN_name`, e.g. `0001_cases`; applied in the order given, which must be ascending. */
  readonly id: string
  readonly sql: string
}

export interface MigrationSet {
  /** The module, also its Postgres schema name. */
  readonly module: string
  readonly migrations: readonly Migration[]
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

/**
 * Functions the row-level security policies read: the apps and mode of the current transaction,
 * or NULL when none is set, so a policy comparing against them matches no row.
 */
export const platformMigrations: MigrationSet = {
  module: 'platform',
  migrations: [
    {
      id: '0001_platform',
      sql: `
-- Defaults every module relies on, and the functions row-level security policies read: the apps
-- and mode of the current transaction, NULL when none is set.
ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{app}};
ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO {{app}};
GRANT USAGE ON SCHEMA platform TO {{app}}, {{system}};
CREATE FUNCTION platform.app_ids() RETURNS text[] LANGUAGE sql STABLE
  AS $$ SELECT string_to_array(NULLIF(current_setting('app.app_ids', true), ''), ',') $$;
CREATE FUNCTION platform.livemode() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.livemode', true), '')::boolean $$;

-- The event log, which is also the outbox: the app role inserts events in the same transaction as
-- the change they describe and reads its own apps' events. Each type names its major
-- (case.triaged.v1) and each event the semver of its schema; request_id and the actor say where
-- it came from, when it was published during an API request. The system role fans events out to
-- consumer groups and delivers them, publishes the bus's own facts about tracked events
-- (bus.event_fanned_out, bus.delivery_dead_lettered) and deletes events past retention; the app
-- role cannot touch deliveries.
CREATE TABLE platform.events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE CHECK (id <> ''),
  type text NOT NULL CHECK (type <> ''),
  key text NOT NULL CHECK (key <> ''),
  data jsonb NOT NULL,
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  fanned_out boolean NOT NULL DEFAULT false,
  request_id text,
  actor_type text,
  actor_id text,
  schema_version text CHECK (schema_version ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'),
  tracked boolean NOT NULL DEFAULT false,
  CHECK ((actor_type IS NULL) = (actor_id IS NULL))
);
CREATE INDEX events_to_fan_out ON platform.events (seq) WHERE NOT fanned_out;
CREATE INDEX events_by_age ON platform.events (created_at) WHERE fanned_out;
ALTER TABLE platform.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.events FORCE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON platform.events FROM {{app}};
CREATE POLICY app_read ON platform.events FOR SELECT TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
CREATE POLICY app_write ON platform.events FOR INSERT TO {{app}}
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.events TO {{system}};
GRANT USAGE ON SEQUENCE platform.events_seq_seq TO {{system}};
CREATE POLICY relay ON platform.events FOR ALL TO {{system}} USING (true) WITH CHECK (true);

CREATE TABLE platform.consumer_groups (
  name text PRIMARY KEY CHECK (name <> ''),
  -- NULL means every type.
  types text[],
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  -- The group receives events with a higher seq only.
  since_seq bigint NOT NULL,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE TABLE platform.deliveries (
  queued bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_name text NOT NULL REFERENCES platform.consumer_groups (name) ON DELETE CASCADE,
  seq bigint NOT NULL REFERENCES platform.events (seq),
  key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  last_error text
);
CREATE INDEX deliveries_heads ON platform.deliveries (group_name, key, queued);

CREATE TABLE platform.dead_letters (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_name text NOT NULL,
  seq bigint NOT NULL REFERENCES platform.events (seq),
  attempts integer NOT NULL,
  error text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dead_letters_by_group ON platform.dead_letters (group_name, seq);

REVOKE ALL ON platform.consumer_groups, platform.deliveries, platform.dead_letters FROM {{app}};
REVOKE ALL ON SEQUENCE platform.consumer_groups_position_seq, platform.deliveries_queued_seq, platform.dead_letters_id_seq FROM {{app}};
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.consumer_groups, platform.deliveries, platform.dead_letters TO {{system}};
GRANT USAGE, SELECT ON SEQUENCE platform.consumer_groups_position_seq, platform.deliveries_queued_seq, platform.dead_letters_id_seq TO {{system}};

-- The first response to each API request's Idempotency-Key, per app and mode; status is NULL
-- while the request runs.
CREATE TABLE platform.idempotency_keys (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  key text NOT NULL CHECK (key <> ''),
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  status integer,
  content_type text,
  body text,
  PRIMARY KEY (app_id, livemode, key),
  CHECK ((status IS NULL) = (body IS NULL) AND (body IS NULL) = (content_type IS NULL))
);
ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON platform.idempotency_keys TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
`,
    },
  ],
}

/**
 * Reads a module's migrations from `dir`: every file named `NNNN_name.sql`, sorted by name, as
 * `{ id: 'NNNN_name', sql }`. Other files are ignored. A MigrationError when the folder cannot be read.
 */
export function loadMigrations(module: string, dir: URL): MigrationSet {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch (err) {
    throw new MigrationError(`Cannot read migrations of ${module}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const migrations = files
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: f.slice(0, -4), sql: readFileSync(new URL(f, dir), 'utf8') }))
  return { module, migrations }
}

const ID = /^\d{4}_[a-z0-9_]+$/
const MODULE = /^[a-z][a-z0-9_]{0,62}$/
const LOCK_KEY = 0x6677_6d67 // "fwmg"

/**
 * Applies every migration not applied yet, connecting as the owner role; returns the ids it applied,
 * as `module/id`. platformMigrations always runs first.
 *
 * - Concurrent runs are safe: a session advisory lock makes them take turns.
 * - Each migration runs in its own transaction, together with its row in
 *   `platform.schema_migrations (module, id, checksum, applied_at)`; a failing migration is rolled
 *   back and its error rethrown as a MigrationError naming it. Earlier migrations stay applied.
 * - Placeholders `{{owner}}`, `{{app}}` and `{{system}}` become the quoted role names; any other
 *   `{{...}}` is a MigrationError. The checksum is the SHA-256 of the SQL before placeholders are
 *   filled, so it does not depend on role names.
 * - MigrationError, before anything runs, when: a module name is not a lowercase identifier or
 *   appears twice; an id is not `NNNN_name`, appears twice in a module, or is not in ascending order;
 *   an applied migration's checksum differs from the given SQL; or an applied migration is missing
 *   from its module's list.
 */
export async function migrate(ownerUrl: string, sets: readonly MigrationSet[], roles: DbRoleNames = DEFAULT_ROLES): Promise<string[]> {
  const all = [platformMigrations, ...sets.filter((s) => s !== platformMigrations)]
  validate(all)
  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query('CREATE SCHEMA IF NOT EXISTS platform')
    await client.query(
      'CREATE TABLE IF NOT EXISTS platform.schema_migrations (module text NOT NULL, id text NOT NULL, checksum text NOT NULL, ' +
        'applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (module, id))',
    )
    // The server checks it through the system role before handling events (pendingMigrations).
    await client.query(`GRANT USAGE ON SCHEMA platform TO "${roles.system}"`)
    await client.query(`GRANT SELECT ON platform.schema_migrations TO "${roles.system}"`)
    const done = await client.query<{ module: string; id: string; checksum: string }>('SELECT module, id, checksum FROM platform.schema_migrations')
    const applied = new Map(done.rows.map((r) => [`${r.module}/${r.id}`, r.checksum]))
    const given = new Set(all.flatMap((s) => s.migrations.map((m) => `${s.module}/${m.id}`)))
    for (const key of applied.keys()) {
      if (!given.has(key)) throw new MigrationError(`Applied migration ${key} is missing from the migrations given`)
    }
    for (const set of all) {
      for (const m of set.migrations) {
        const key = `${set.module}/${m.id}`
        const sum = checksum(m.sql)
        const prior = applied.get(key)
        if (prior !== undefined && prior !== sum) throw new MigrationError(`Migration ${key} changed after it was applied`)
      }
    }

    const ran: string[] = []
    for (const set of all) {
      for (const m of set.migrations) {
        const key = `${set.module}/${m.id}`
        if (applied.has(key)) continue
        const sql = fill(m.sql, roles, key)
        try {
          await client.query('BEGIN')
          await client.query(sql)
          await client.query('INSERT INTO platform.schema_migrations (module, id, checksum) VALUES ($1, $2, $3)', [set.module, m.id, checksum(m.sql)])
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw new MigrationError(`Migration ${key} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        ran.push(key)
      }
    }
    return ran
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    await client.end()
  }
}

/**
 * The migrations of `sets` (and platformMigrations) not applied yet, as `module/id`, read through
 * the system role; all of them when the migration table does not exist yet or the role cannot read it. Migrations applied but
 * not given are ignored, so a server one release behind still finds its schema complete.
 */
export async function pendingMigrations(db: Pick<Database, 'system'>, sets: readonly MigrationSet[]): Promise<string[]> {
  const all = [platformMigrations, ...sets.filter((s) => s !== platformMigrations)]
  const wanted = all.flatMap((s) => s.migrations.map((m) => `${s.module}/${m.id}`))
  // Not readable also before the grant that migrate() adds on its next run. The schema is checked
  // first: while a migration job runs, it can exist before its USAGE grant, and looking a table up
  // in it then fails instead of returning null.
  const table = await db.system.execute<{ ok: boolean }>(
    sql`SELECT CASE WHEN to_regnamespace('platform') IS NULL OR NOT has_schema_privilege('platform', 'USAGE') THEN false
      WHEN to_regclass('platform.schema_migrations') IS NULL THEN false
      ELSE has_table_privilege('platform.schema_migrations', 'SELECT') END AS ok`,
  )
  if (!table.rows[0]?.ok) return wanted
  const done = await db.system.execute<{ key: string }>(sql`SELECT module || '/' || id AS key FROM platform.schema_migrations`)
  const applied = new Set(done.rows.map((r) => r.key))
  return wanted.filter((key) => !applied.has(key))
}

function validate(sets: readonly MigrationSet[]): void {
  const modules = new Set<string>()
  for (const set of sets) {
    if (!MODULE.test(set.module)) throw new MigrationError(`Not a valid module name: ${JSON.stringify(set.module)}`)
    if (modules.has(set.module)) throw new MigrationError(`Module ${set.module} is listed twice`)
    modules.add(set.module)
    let previous = ''
    for (const m of set.migrations) {
      if (!ID.test(m.id)) throw new MigrationError(`Not a valid migration id: ${set.module}/${m.id}`)
      if (m.id <= previous) throw new MigrationError(`Migration ${set.module}/${m.id} is a duplicate or out of order`)
      previous = m.id
    }
  }
}

function fill(sql: string, roles: DbRoleNames, key: string): string {
  return sql.replace(/\{\{([^}]*)\}\}/g, (_m, name: string) => {
    if (name !== 'owner' && name !== 'app' && name !== 'system') throw new MigrationError(`Unknown placeholder {{${name}}} in ${key}`)
    return `"${roles[name]}"`
  })
}

const checksum = (sql: string) => createHash('sha256').update(sql, 'utf8').digest('hex')
