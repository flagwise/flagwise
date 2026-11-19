// Compares Drizzle table definitions with the tables the migrations created, so the two cannot
// drift apart.

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import pg from 'pg'

/**
 * The differences between `tables` and the database, as readable lines; empty when they match.
 * For each table it compares the column names, their types (as Postgres `format_type` writes them,
 * e.g. `text`, `integer`, `timestamp with time zone`, `text[]`) and NOT NULL.
 */
export async function schemaDrift(ownerUrl: string, tables: readonly PgTable[]): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    const problems: string[] = []
    for (const table of tables) {
      const cfg = getTableConfig(table)
      const schema = cfg.schema ?? 'public'
      const name = `${schema}.${cfg.name}`
      const res = await client.query<{ column: string; type: string; not_null: boolean }>(
        `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
        [schema, cfg.name],
      )
      if (res.rowCount === 0) {
        problems.push(`${name}: table missing in the database`)
        continue
      }
      const db = new Map(res.rows.map((r) => [r.column, r]))
      for (const col of cfg.columns) {
        const found = db.get(col.name)
        if (!found) {
          problems.push(`${name}.${col.name}: missing in the database`)
          continue
        }
        if (found.type !== col.getSQLType()) problems.push(`${name}.${col.name}: database type ${found.type}, schema type ${col.getSQLType()}`)
        if (found.not_null !== col.notNull) problems.push(`${name}.${col.name}: database ${found.not_null ? 'NOT NULL' : 'nullable'}, schema ${col.notNull ? 'NOT NULL' : 'nullable'}`)
        db.delete(col.name)
      }
      for (const extra of db.keys()) problems.push(`${name}.${extra}: missing in the schema`)
    }
    return problems
  } finally {
    await client.end()
  }
}
