// A throwaway database for tests: its own database and roles with random names, dropped afterwards.
// Needs TEST_DATABASE_URL: a user that can create databases and roles. `pnpm test` sets it (its own
// throwaway Postgres unless given one); tests that need it skip when it is not set.

import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { initDatabase, type DbRoleNames } from '../db/init.ts'

export const testDatabaseUrl: string | undefined = process.env.TEST_DATABASE_URL || undefined

export interface TestDatabase {
  readonly database: string
  readonly roles: DbRoleNames
  readonly ownerUrl: string
  readonly appUrl: string
  readonly systemUrl: string
  /** Drops the database (closing its connections) and the roles. */
  drop(): Promise<void>
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set')
  const suffix = randomBytes(5).toString('hex')
  const database = `fw_test_${suffix}`
  const roles: DbRoleNames = { owner: `fwt_${suffix}_owner`, app: `fwt_${suffix}_app`, system: `fwt_${suffix}_system` }
  const passwords = { owner: randomBytes(12).toString('hex'), app: randomBytes(12).toString('hex'), system: randomBytes(12).toString('hex') }
  await initDatabase({ adminUrl: testDatabaseUrl, database, roles, passwords })
  const urlFor = (key: keyof DbRoleNames) => {
    const url = new URL(testDatabaseUrl!)
    url.username = roles[key]
    url.password = passwords[key]
    url.pathname = `/${database}`
    return url.toString()
  }
  return {
    database,
    roles,
    ownerUrl: urlFor('owner'),
    appUrl: urlFor('app'),
    systemUrl: urlFor('system'),
    async drop() {
      const client = new pg.Client({ connectionString: testDatabaseUrl })
      await client.connect()
      try {
        await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        for (const role of [roles.owner, roles.app, roles.system]) await client.query(`DROP ROLE IF EXISTS "${role}"`)
      } finally {
        await client.end()
      }
    },
  }
}
