// Prepares the roles Flagwise runs as. Row-level security only protects tenants when queries run as
// a role that does not own the tables, so the app and system roles exist in both setups:
// - separate roles (initDatabase): each role logs in with its own password, and the server never
//   holds the owner's;
// - one database URL (initSingleUser): the URL's user owns the tables, and the server's connections
//   switch to the app and system roles as they log in (see createDatabase's `assumeRoles`).

import pg from 'pg'

/** The three roles: `owner` runs migrations, `app` serves the API and workers, `system` reads the tenant registry and the outbox. */
export interface DbRoleNames {
  readonly owner: string
  readonly app: string
  readonly system: string
}

export const DEFAULT_ROLES: DbRoleNames = { owner: 'fw_owner', app: 'fw_app', system: 'fw_system' }

export interface InitDatabaseOptions {
  /** Connection string of a user that can create roles (and the database, when it does not exist yet). */
  readonly adminUrl: string
  readonly database: string
  readonly roles?: DbRoleNames
  readonly passwords: Readonly<Record<keyof DbRoleNames, string>>
  /** statement_timeout for the app and system roles; default 15 000 ms. */
  readonly statementTimeoutMs?: number
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Prepares a database for Flagwise; safe to run again.
 *
 * - Throws, changing nothing, when the admin user can neither create roles nor is a superuser, or
 *   when the database does not exist and the user cannot create databases. The error says why: the
 *   app must not run as the user that owns the tables.
 * - Throws a RangeError for a database or role name that is not a lowercase identifier
 *   (`[a-z_][a-z0-9_]*`, at most 63 characters), or for two roles with the same name.
 * - Creates each role, or updates it when it exists, as LOGIN with the given password and without
 *   SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS.
 * - Creates the database when it is missing; grants CONNECT to all three roles and CREATE to the
 *   owner role.
 * - Sets statement_timeout on the app and system roles.
 */
export async function initDatabase(opts: InitDatabaseOptions): Promise<void> {
  const roles = opts.roles ?? DEFAULT_ROLES
  for (const name of [opts.database, roles.owner, roles.app, roles.system]) {
    if (!IDENTIFIER.test(name)) throw new RangeError(`Not a valid database identifier: ${JSON.stringify(name)}`)
  }
  if (new Set([roles.owner, roles.app, roles.system]).size !== 3) throw new RangeError('The owner, app and system roles must be different')
  const timeout = opts.statementTimeoutMs ?? 15_000
  if (!Number.isInteger(timeout) || timeout <= 0) throw new RangeError('statementTimeoutMs must be a positive integer')

  const client = new pg.Client({ connectionString: opts.adminUrl })
  await client.connect()
  try {
    const me = await client.query<{ can_roles: boolean; can_db: boolean }>(
      'SELECT rolsuper OR rolcreaterole AS can_roles, rolsuper OR rolcreatedb AS can_db FROM pg_roles WHERE rolname = current_user',
    )
    if (!me.rows[0]?.can_roles) {
      throw new Error(
        'initDatabase needs a user that can create roles. Flagwise runs as three roles so that row-level security ' +
          'applies to every query; it cannot create them as this user.',
      )
    }
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.database])
    if (exists.rowCount === 0 && !me.rows[0].can_db) {
      throw new Error(`Database ${opts.database} does not exist and the admin user cannot create it`)
    }

    for (const key of ['owner', 'app', 'system'] as const) {
      const name = roles[key]
      const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])
      const options = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(opts.passwords[key])}`
      await client.query(found.rowCount === 0 ? `CREATE ROLE "${name}" ${options}` : `ALTER ROLE "${name}" ${options}`)
    }
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${opts.database}"`)
    await client.query(`GRANT CONNECT ON DATABASE "${opts.database}" TO "${roles.owner}", "${roles.app}", "${roles.system}"`)
    await client.query(`GRANT CREATE ON DATABASE "${opts.database}" TO "${roles.owner}"`)
    for (const name of [roles.app, roles.system]) {
      await client.query(`ALTER ROLE "${name}" SET statement_timeout = ${timeout}`)
    }
  } finally {
    await client.end()
  }
}

/** A database setup that retrying will not fix: a user without the rights it needs, or roles that would skip row-level security. */
export class DatabaseSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseSetupError'
  }
}

/**
 * Prepares a database reached through one URL, whose user owns the tables; safe to run again, also
 * concurrently.
 *
 * - Creates the app and system roles when missing, as NOLOGIN (no password, nobody logs in as them)
 *   and without SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. Roles that exist already,
 *   such as login roles from initDatabase, are kept.
 * - Makes the URL's user able to switch to them (SET ROLE), granting the membership when it is
 *   missing.
 * - DatabaseSetupError when the URL's user is the app or system role itself, when a role is missing
 *   and the user cannot create roles, when an existing role is a superuser or bypasses row-level
 *   security (these change nothing), or when the user cannot be granted a role it did not create.
 */
export async function initSingleUser(url: string, roles: Pick<DbRoleNames, 'app' | 'system'> = DEFAULT_ROLES): Promise<void> {
  for (const name of [roles.app, roles.system]) {
    if (!IDENTIFIER.test(name)) throw new RangeError(`Not a valid database identifier: ${JSON.stringify(name)}`)
  }
  if (roles.app === roles.system) throw new RangeError('The app and system roles must be different')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const me = await client.query<{ name: string; can_roles: boolean; version: number }>(
      "SELECT current_user AS name, rolsuper OR rolcreaterole AS can_roles, current_setting('server_version_num')::int AS version FROM pg_roles WHERE rolname = current_user",
    )
    const { name: user, can_roles: canRoles, version } = me.rows[0]!
    if (user === roles.app || user === roles.system) {
      throw new DatabaseSetupError(`The database URL logs in as ${user}; it must be the user that owns the tables, not the ${user === roles.app ? 'app' : 'system'} role`)
    }
    const found = await client.query<{ rolname: string; unsafe: boolean }>('SELECT rolname, rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname = ANY($1)', [
      [roles.app, roles.system],
    ])
    const existing = new Map(found.rows.map((r) => [r.rolname, r.unsafe]))
    for (const [name, unsafe] of existing) {
      if (unsafe) throw new DatabaseSetupError(`Role ${name} is a superuser or bypasses row-level security; Flagwise will not run as it`)
    }
    const missing = [roles.app, roles.system].filter((name) => !existing.has(name))
    if (missing.length > 0 && !canRoles) {
      throw new DatabaseSetupError(
        `${user} cannot create roles, and ${missing.join(' and ')} ${missing.length > 1 ? 'do' : 'does'} not exist. Create ${missing.length > 1 ? 'them' : 'it'} ` +
          `(NOLOGIN) and grant ${missing.length > 1 ? 'them' : 'it'} to ${user}, or use separate role URLs with db:init.`,
      )
    }
    for (const name of missing) {
      try {
        await client.query(`CREATE ROLE "${name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
      } catch (err) {
        // Another run created it first.
        if ((err as { code?: string }).code !== '42710') throw err
      }
    }
    // Postgres 16 split membership into the rights to inherit and to SET ROLE; only the second is needed.
    const right = version >= 160000 ? 'SET' : 'MEMBER'
    for (const name of [roles.app, roles.system]) {
      const has = await client.query<{ ok: boolean }>(`SELECT pg_has_role(current_user, $1, '${right}') AS ok`, [name])
      if (has.rows[0]!.ok) continue
      try {
        await client.query(version >= 160000 ? `GRANT "${name}" TO CURRENT_USER WITH SET TRUE, INHERIT FALSE` : `GRANT "${name}" TO CURRENT_USER`)
      } catch (err) {
        if ((err as { code?: string }).code !== '42501') throw err
        throw new DatabaseSetupError(`${user} cannot switch to role ${name} and cannot grant it to itself; grant it as an admin (GRANT ${name} TO ${user})`)
      }
    }
  } finally {
    await client.end()
  }
}
