// Runs the test suites (vitest.config.ts: unit, database, integration) from the root. The database
// and integration suites get a Postgres: TEST_DATABASE_URL when it is set (CI, a shared dev
// database), else a throwaway one started here from the embedded-postgres binaries and removed
// afterwards, so `pnpm test` and `pnpm verify` need no settings. Arguments go to vitest.
//
//   node scripts/test.ts                                    every suite
//   node scripts/test.ts --project unit                     one suite (no Postgres started)
//   node scripts/test.ts --project database moderation      one suite, files whose path has `moderation`

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

const args = process.argv.slice(2)

/** The suites the arguments name (`--project x` or `--project=x`); none means every suite. */
const projects = args.flatMap((a, i) => (a === '--project' ? [args[i + 1] ?? ''] : a.startsWith('--project=') ? [a.slice('--project='.length)] : []))
const needsPostgres = projects.length === 0 || projects.some((p) => p !== 'unit')

/** A port nothing listens on right now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

let stopPostgres = async () => {}
const env = { ...process.env }
if (needsPostgres && !env['TEST_DATABASE_URL']) {
  const dir = mkdtempSync(join(tmpdir(), 'flagwise-test-pg-'))
  const port = await freePort()
  const password = 'flagwise-test'
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password,
    persistent: false,
    // Every test file makes its own database and roles; durability does not matter for a throwaway.
    postgresFlags: ['-c', 'max_connections=500', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: () => {},
    onError: (err: unknown) => console.error(String(err)),
  })
  await pg.initialise()
  await pg.start()
  env['TEST_DATABASE_URL'] = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`
  console.log(`Tests use a throwaway Postgres on port ${port} (set TEST_DATABASE_URL to use your own).`)
  stopPostgres = async () => {
    await pg.stop().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

// Ctrl-C reaches the tests too; wait for them to stop, then remove the database.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {})
const vitest = join(import.meta.dirname, '../node_modules/vitest/vitest.mjs')
const child = spawn(process.execPath, [vitest, 'run', ...args], { stdio: 'inherit', env })
const code = await new Promise<number>((resolve) => child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0))))
await stopPostgres()
process.exitCode = code
