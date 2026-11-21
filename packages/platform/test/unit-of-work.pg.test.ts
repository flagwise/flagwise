// A service's unit of work on Postgres: its stores' writes and the events it publishes commit in
// one app transaction, or neither does. Runs against a real Postgres; skipped without it.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, createPgBus, migrate, pgUnitOfWork, withApps, type AppTx, type Database, type MigrationSet, type PgBus } from '../src/index.ts'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../src/testing/pg.ts'

const A = { appId: 'app_a', livemode: true }
const sample: MigrationSet = {
  module: 'sample',
  migrations: [
    {
      id: '0001_notes',
      sql: `
CREATE SCHEMA sample;
GRANT USAGE ON SCHEMA sample TO {{app}};
CREATE TABLE sample.notes (id text PRIMARY KEY, app_id text NOT NULL, livemode boolean NOT NULL, body text NOT NULL);
GRANT SELECT, INSERT ON sample.notes TO {{app}};
ALTER TABLE sample.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample.notes FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON sample.notes TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
`,
    },
  ],
}

/** A service's store: notes of the run's app. */
const notesOf = (tx: AppTx) => ({
  add: (id: string) => tx.execute(sql`INSERT INTO sample.notes (id, app_id, livemode, body) VALUES (${id}, ${A.appId}, ${A.livemode}, 'Jane Doe')`),
})

describe.skipIf(!testDatabaseUrl)('a unit of work on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  const notes = () => withApps(db, { appIds: [A.appId], livemode: true }, async (tx) => (await tx.execute(sql`SELECT id FROM sample.notes ORDER BY id`)).rows.map((r) => r['id']))
  const logged = async () => (await bus.log()).map((l) => l.event.id)

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [sample], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { retryDelayMs: () => 0 })
  })
  afterAll(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
  })

  it('commits the writes and the events of a run together', async () => {
    const uow = pgUnitOfWork(db, bus, (tx) => ({ notes: notesOf(tx) }))
    await uow.run(A, async (w) => {
      await w.stores.notes.add('note_1')
      await w.publish({ id: 'evt_1', type: 'note.added', key: 'note_1', data: { noteId: 'note_1' } })
    })
    expect(await notes()).toEqual(['note_1'])
    expect(await logged()).toEqual(['evt_1'])
  })

  it('rolls back a run that throws: no writes, no events', async () => {
    const uow = pgUnitOfWork(db, bus, (tx) => ({ notes: notesOf(tx) }))
    await expect(
      uow.run(A, async (w) => {
        await w.stores.notes.add('note_2')
        await w.publish({ id: 'evt_2', type: 'note.added', key: 'note_2', data: { noteId: 'note_2' } })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await notes()).toEqual(['note_1'])
    expect(await logged()).toEqual(['evt_1'])
  })
})
