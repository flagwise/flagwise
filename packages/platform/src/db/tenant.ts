// Connection pools and tenant-scoped transactions. Repositories take a TenantTx, so a query without
// a tenant context does not type-check; the context lives only for the transaction.

import type { TenantContext, TenantRef } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
declare const tenantBrand: unique symbol
declare const systemBrand: unique symbol

/** A transaction with a tenant context set; row-level security limits it to that tenant. */
export type TenantTx = Tx & { readonly [tenantBrand]: true }
/** A transaction as the system role, which only sees the tenant registry and the outbox. */
export type SystemTx = Tx & { readonly [systemBrand]: true }

export interface TenantScope {
  /** The apps the transaction may see; empty for work on no app. */
  readonly appIds: readonly string[]
  readonly livemode: boolean
}

export interface Database {
  readonly app: NodePgDatabase
  readonly system: NodePgDatabase
  close(): Promise<void>
}

export interface DatabaseOptions {
  /** Connection string of the app role, or of the table owner with `assumeRoles`. */
  readonly appUrl: string
  /** Connection string of the system role, or of the table owner with `assumeRoles`. */
  readonly systemUrl: string
  /** Pool size per role; default 10. */
  readonly max?: number
  /**
   * For URLs that log in as the user owning the tables (one database URL): each connection takes
   * this role as it logs in (the `role` startup option) with a 15 s statement timeout, so row-level
   * security applies to every query on it. A connection that cannot take its role fails to open;
   * it never runs as the owner. See initSingleUser.
   */
  readonly assumeRoles?: { readonly app: string; readonly system: string }
}

/** Opens one pool per role. Idle-client errors are reported through `onError` instead of crashing the process. */
export function createDatabase(opts: DatabaseOptions, onError: (err: Error) => void = () => {}): Database {
  const pool = (url: string, name: string, role: string | undefined) =>
    new pg.Pool({
      connectionString: url,
      max: opts.max ?? 10,
      application_name: name,
      ...(role ? { options: `-c role=${role} -c statement_timeout=15000` } : {}),
    })
  for (const role of opts.assumeRoles ? [opts.assumeRoles.app, opts.assumeRoles.system] : []) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new RangeError(`Not a valid database identifier: ${JSON.stringify(role)}`)
  }
  const appPool = pool(opts.appUrl, 'flagwise-app', opts.assumeRoles?.app)
  const systemPool = pool(opts.systemUrl, 'flagwise-system', opts.assumeRoles?.system)
  appPool.on('error', onError)
  systemPool.on('error', onError)
  return {
    app: drizzle({ client: appPool }),
    system: drizzle({ client: systemPool }),
    async close() {
      await Promise.all([appPool.end(), systemPool.end()])
    },
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Runs `fn` in a transaction of the app role with the tenant context set through `set_config(...,
 * true)`: `app.app_ids` (comma-separated) and `app.livemode` (`true` / `false`). The
 * context ends with the transaction, so a pooled connection never carries it into the next one.
 * Commits when `fn` resolves and rolls back when it throws, rethrowing the error.
 *
 * A RangeError, before any query, when an app id is not 1 to 64 of
 * `A-Z a-z 0-9 _ -`.
 */
export async function withTenant<T>(db: Database, scope: TenantScope, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  for (const id of scope.appIds) if (!ID.test(id)) throw new RangeError(`Not a valid app id: ${JSON.stringify(id)}`)
  return db.app.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.app_ids', ${scope.appIds.join(',')}, true), set_config('app.livemode', ${String(scope.livemode)}, true)`,
    )
    return fn(tx as TenantTx)
  })
}

/** Runs `fn` in a transaction of the system role, with no tenant context. */
export async function withSystem<T>(db: Database, fn: (tx: SystemTx) => Promise<T>): Promise<T> {
  return db.system.transaction(async (tx) => fn(tx as SystemTx))
}

/** The scope of a job or outbox row: its one app. */
export function scopeOfRef(ref: TenantRef): TenantScope {
  return { appIds: [ref.appId], livemode: ref.livemode }
}

/** The scope of a request: the apps its actor may read. */
export function scopeOfContext(ctx: TenantContext): TenantScope {
  return { appIds: ctx.appIds, livemode: ctx.livemode }
}
