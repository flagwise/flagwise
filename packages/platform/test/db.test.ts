// The database helpers' input checks, which refuse bad input before any connection.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { initDatabase, loadMigrations, migrate, MigrationError, withApps, type Database, type MigrationSet } from '../src/index.ts'

describe('input checks', () => {
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

  it('withApps rejects ids that cannot be ids, before any query', async () => {
    const db = { app: { transaction: () => Promise.reject(new Error('queried')) } } as unknown as Database
    await expect(withApps(db, { appIds: ["app'x"], livemode: true }, async () => 1)).rejects.toThrow(RangeError)
    await expect(withApps(db, { appIds: ['app_a', ''], livemode: true }, async () => 1)).rejects.toThrow(RangeError)
    await expect(withApps(db, { appIds: ['a'.repeat(65)], livemode: true }, async () => 1)).rejects.toThrow(RangeError)
  })
})
