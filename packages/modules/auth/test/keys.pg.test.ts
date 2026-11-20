// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { eventContract } from '@flagwise/contracts'
import { manualClock, type ManualClock } from '@flagwise/kernel'
import { createDatabase, createPgBus, migrate, withSystem, withApps, type Database, type PgBus } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  authMigrations,
  authTables,
  issueApiKey,
  pgAppCopies,
  pgKeyDirectory,
  pgKeyStore,
  resolveApiKey,
  revokeApiKey,
  rotateApiKey,
  subscribeAuth,
  type AppCopies,
  type KeyDeps,
  type KeyEvent,
} from '../src/index.ts'

const H = 3_600_000

describe.skipIf(!testDatabaseUrl)('API keys on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let clock: ManualClock
  let apps: AppCopies
  let n = 0
  const ids = (prefix: string) => `${prefix}_${++n}`
  /** An app transaction for the listed apps, with the key deps on it. */
  const asApps = <R>(appIds: string[], fn: (deps: KeyDeps) => Promise<R>) =>
    withApps(db, { appIds, livemode: true }, (tx) => fn({ store: pgKeyStore(tx), clock, newKeyId: () => ids('key') }))
  const resolve = (key: string, at = clock.now()) => withSystem(db, (tx) => resolveApiKey(pgKeyDirectory(tx), key, at))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [authMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    clock = manualClock('2026-11-05T09:00:00Z')
    apps = pgAppCopies(db)
    await apps.created('app_a')
    await apps.created('app_b')
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, authTables)).toEqual([])
  })

  it('issues a key shown once, and resolves it to its app, mode and scopes', async () => {
    const issued = await asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['admin', 'flagging', 'flagging'] }))
    expect(issued.key).toMatch(/^fw_live_[0-9A-Za-z]{40}$/)
    expect(issued.masked).toBe(`fw_live_${issued.key.slice(8, 20)}…`)
    expect(issued.record).toMatchObject({ appId: 'app_a', livemode: true, scopes: ['flagging', 'admin'] })
    expect(issued.record.hash).not.toContain(issued.key.slice(8))
    expect(await resolve(issued.key)).toEqual({
      ok: true,
      context: {
        appId: 'app_a',
        appIds: ['app_a'],
        actor: { type: 'api_key', id: issued.record.id, scopes: ['flagging', 'admin'] },
        adminRole: null,
        appRoles: {},
        livemode: true,
      },
    })
    const test = await asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: false, scopes: ['flagging'] }))
    expect(await resolve(test.key)).toMatchObject({ ok: true, context: { livemode: false } })
  })

  it('refuses malformed, unknown and tampered keys alike', async () => {
    const issued = await asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['flagging'] }))
    expect(await resolve('Bearer nonsense')).toEqual({ ok: false, reason: 'malformed' })
    expect(await resolve(`fw_live_${'a'.repeat(40)}`)).toEqual({ ok: false, reason: 'unknown' })
    // Same lookup prefix, different rest of the body: the hash does not match.
    const last = issued.key.at(-1) === 'a' ? 'b' : 'a'
    expect(await resolve(`${issued.key.slice(0, -1)}${last}`)).toEqual({ ok: false, reason: 'unknown' })
    // A live key presented as a test key.
    expect(await resolve(issued.key.replace('fw_live_', 'fw_test_'))).toEqual({ ok: false, reason: 'unknown' })
  })

  it('keeps an old key working through the rotation overlap, then stops it', async () => {
    const old = await asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['flagging', 'actions'] }))
    const fresh = await asApps(['app_a'], (d) => rotateApiKey(d, { appId: 'app_a', keyId: old.record.id, overlapMs: 2 * H }))
    expect(fresh.record.scopes).toEqual(['flagging', 'actions'])
    expect(await resolve(old.key, new Date(clock.now().getTime() + 2 * H - 1))).toMatchObject({ ok: true })
    expect(await resolve(old.key, new Date(clock.now().getTime() + 2 * H))).toEqual({ ok: false, reason: 'inactive' })
    expect(await resolve(fresh.key, new Date(clock.now().getTime() + 3 * H))).toMatchObject({ ok: true })
    // Rotating a key that is already winding down, with a longer overlap, cannot extend its life.
    await asApps(['app_a'], (d) => rotateApiKey(d, { appId: 'app_a', keyId: fresh.record.id, overlapMs: H }))
    await asApps(['app_a'], (d) => rotateApiKey(d, { appId: 'app_a', keyId: fresh.record.id, overlapMs: 7 * 24 * H }))
    expect(await resolve(fresh.key, new Date(clock.now().getTime() + H))).toEqual({ ok: false, reason: 'inactive' })
    await expect(asApps(['app_a'], (d) => rotateApiKey(d, { appId: 'app_a', keyId: fresh.record.id, overlapMs: 0 }))).rejects.toThrow(RangeError)
  })

  it('stops a revoked key at once', async () => {
    const issued = await asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['flagging'] }))
    await asApps(['app_a'], (d) => revokeApiKey(d, { appId: 'app_a', keyId: issued.record.id }))
    expect(await resolve(issued.key)).toEqual({ ok: false, reason: 'inactive' })
    await expect(asApps(['app_a'], (d) => rotateApiKey(d, { appId: 'app_a', keyId: issued.record.id, overlapMs: H }))).rejects.toThrow('No active API key')
  })

  it('tells a deleted app apart, so flagging can answer 410', async () => {
    await apps.created('app_gone')
    const issued = await asApps(['app_gone'], (d) => issueApiKey(d, { appId: 'app_gone', livemode: true, scopes: ['flagging'] }))
    await apps.setDeletedAt('app_gone', clock.now())
    expect(await resolve(issued.key)).toEqual({ ok: false, reason: 'app_deleted' })
    await expect(asApps(['app_gone'], (d) => issueApiKey(d, { appId: 'app_gone', livemode: true, scopes: ['flagging'] }))).rejects.toThrow('No app app_gone')
  })

  it('refuses bad scopes and names', async () => {
    await expect(asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: [] }))).rejects.toThrow('Scopes')
    await expect(asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['root'] }))).rejects.toThrow('Scopes')
    await expect(asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_unknown', livemode: true, scopes: ['flagging'] }))).rejects.toThrow('No app app_unknown')
  })

  it('keeps appRefs apart, and lets the system role only read', async () => {
    const issued = await asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['flagging'] }))
    // A transaction for other apps cannot see app A or its key, even when it asks for them by id.
    expect(await asApps(['app_b'], (d) => d.store.findApp('app_a'))).toBeNull()
    expect(await asApps(['app_b'], (d) => d.store.findApiKey('app_a', issued.record.id))).toBeNull()
    // Nor issue a key for an app outside the apps it may see.
    await expect(asApps(['app_a'], (d) => issueApiKey(d, { appId: 'app_b', livemode: true, scopes: ['flagging'] }))).rejects.toThrow('No app app_b')
    // The system role reads the registry but cannot write it.
    await expect(withSystem(db, (tx) => tx.execute(sql`UPDATE auth.api_keys SET revoked_at = now()`))).rejects.toThrow()
    expect(await resolve(issued.key)).toMatchObject({ ok: true })
  })

  it('publishes key changes with ids and scopes, never the key', async () => {
    const seen: KeyEvent[] = []
    const withEvents = <R>(fn: (deps: KeyDeps) => Promise<R>) => asApps(['app_a'], (d) => fn({ ...d, events: { publish: async (e) => void seen.push(e) } }))
    const appRef = { appId: 'app_a', livemode: true }
    const issued = await withEvents((d) => issueApiKey(d, { appId: 'app_a', livemode: true, scopes: ['admin'] }))
    const rotated = await withEvents((d) => rotateApiKey(d, { appId: 'app_a', keyId: issued.record.id, overlapMs: H }))
    await withEvents((d) => revokeApiKey(d, { appId: 'app_a', keyId: rotated.record.id }))
    // Revoking an ended key changes nothing, so it publishes nothing.
    await withEvents((d) => revokeApiKey(d, { appId: 'app_a', keyId: rotated.record.id }))
    const now = clock.now()
    expect(seen).toEqual([
      { type: 'api_key.issued', appRef, keyId: issued.record.id, scopes: ['admin'], occurredAt: now },
      { type: 'api_key.issued', appRef, keyId: rotated.record.id, scopes: ['admin'], occurredAt: now },
      { type: 'api_key.rotated', appRef, keyId: issued.record.id, replacedBy: rotated.record.id, expiresAt: new Date(now.getTime() + H), occurredAt: now },
      { type: 'api_key.revoked', appRef, keyId: rotated.record.id, occurredAt: now },
    ])
    expect(JSON.stringify(seen)).not.toContain(issued.key.slice(8))
  })

  it("keeps auth's copy of the apps from the apps service's facts, in order", async () => {
    const bus: PgBus = createPgBus(db, { retryDelayMs: () => 0, contract: eventContract })
    try {
      subscribeAuth(bus, { apps, clock })
      await bus.drain()
      const fact = (type: string, data: Record<string, unknown>) =>
        withApps(db, { appIds: ['app_c'], livemode: true }, (tx) =>
          bus.publish({ id: ids('evt'), type, key: 'app_c', data: { appId: 'app_c', occurredAt: clock.now(), ...data }, appRef: { appId: 'app_c', livemode: true } }, tx),
        )
      await fact('app.created.v1', { name: 'Jane Doe Chat' })
      await bus.drain()
      const issued = await asApps(['app_c'], (d) => issueApiKey(d, { appId: 'app_c', livemode: true, scopes: ['flagging'] }))
      expect(await resolve(issued.key)).toMatchObject({ ok: true })
      await fact('app.deletion_requested.v1', { purgeAt: new Date(clock.now().getTime() + 30 * 24 * H) })
      await bus.drain()
      expect(await resolve(issued.key)).toEqual({ ok: false, reason: 'app_deleted' })
      // A created fact delivered again does not undo the deletion.
      await fact('app.created.v1', { name: 'Jane Doe Chat' })
      await bus.drain()
      expect(await resolve(issued.key)).toEqual({ ok: false, reason: 'app_deleted' })
      await fact('app.restored.v1', {})
      await bus.drain()
      expect(await resolve(issued.key)).toMatchObject({ ok: true })
    } finally {
      await bus.stop()
    }
  })
})
