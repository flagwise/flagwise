// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type ManualClock, type TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditMigrations, auditTables, pgAuditStore, recordEvent, verifyAuditLog, type AuditQuery, type RecordedEvent } from '../src/index.ts'

const A: TenantRef = { appId: 'app_a', livemode: true }
const A_TEST: TenantRef = { ...A, livemode: false }
const B: TenantRef = { appId: 'app_b', livemode: true }

describe.skipIf(!testDatabaseUrl)('the audit log on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let clock: ManualClock
  let n = 0
  const scope = (tenant: TenantRef) => ({ appIds: [tenant.appId], livemode: tenant.livemode })
  const record = (tenant: TenantRef, event: RecordedEvent) => withTenant(db, scope(tenant), (tx) => recordEvent({ store: pgAuditStore(tx), clock }, tenant, event))
  const search = (tenant: TenantRef, query: Partial<AuditQuery> = {}) => withTenant(db, scope(tenant), (tx) => pgAuditStore(tx).search(tenant, { limit: 50, ...query }))
  const verify = (tenant: TenantRef) => withTenant(db, scope(tenant), (tx) => verifyAuditLog({ store: pgAuditStore(tx) }, tenant))
  /** As the database superuser, which row-level security does not limit: for tampering. */
  const asSuperuser = async (text: string) => {
    const url = new URL(testDatabaseUrl!)
    url.pathname = `/${t.database}`
    const su = createDatabase({ appUrl: url.toString(), systemUrl: url.toString(), max: 1 })
    try {
      await su.app.execute(sql.raw(text))
    } finally {
      await su.close()
    }
  }
  const claimed = (tenant: TenantRef, caseId: string, by = 'key_jane') => ({
    id: `evt_${++n}`,
    type: 'case.claimed',
    data: { tenant, caseId, memberId: by, occurredAt: clock.now().toISOString() },
    meta: { requestId: `req_${n}`, actor: { type: 'api_key', id: by } },
  })

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [auditMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    clock = manualClock('2026-11-11T09:00:00Z')
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, auditTables)).toEqual([])
  })

  it('appends each event once to its own chain, in the order they are handled', async () => {
    const first = claimed(A, 'case_1')
    const entry = await record(A, first)
    expect(entry).toMatchObject({ seq: 1, actor: { type: 'api_key', id: 'key_jane' }, action: 'case.claimed', target: { type: 'case', id: 'case_1' }, facts: { holder: 'key_jane', request_id: first.meta.requestId } })
    // A redelivery is not recorded again.
    expect(await record(A, first)).toBeNull()
    clock.advance(1_000)
    expect(await record(A, claimed(A, 'case_2', 'key_john'))).toMatchObject({ seq: 2, prevHash: entry!.hash })
    // Test mode and other tenants have chains of their own.
    expect(await record(A_TEST, claimed(A_TEST, 'case_t'))).toMatchObject({ seq: 1 })
    expect(await record(B, claimed(B, 'case_b'))).toMatchObject({ seq: 1 })
    // Types the log does not record write nothing.
    expect(await record(A, { id: 'evt_x', type: 'case.unknown', data: {} })).toBeNull()

    expect((await search(A)).data.map((e) => [e.seq, e.target.id])).toEqual([
      [1, 'case_1'],
      [2, 'case_2'],
    ])
    expect(await verify(A)).toEqual({ ok: true, checked: 2 })
  })

  it('appends concurrent events without gaps or forks', async () => {
    const tenant: TenantRef = { appId: 'app_c', livemode: true }
    await Promise.all(Array.from({ length: 12 }, (_, i) => record(tenant, claimed(tenant, `case_${i}`))))
    expect((await search(tenant)).data.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(await verify(tenant)).toEqual({ ok: true, checked: 12 })
  })

  it('searches by actor, case, subject and time, a page at a time', async () => {
    const tenant: TenantRef = { appId: 'app_d', livemode: true }
    const decided = (caseId: string, subject: string) => ({
      id: `evt_${++n}`,
      type: 'case.decided',
      data: { tenant, caseId, subjectExternalId: subject, decisionId: `dec_${n}`, outcome: 'violation', categoryId: 'spam.spam', severity: 'P2', actionKeys: [], decidedBy: 'key_jane', occurredAt: clock.now().toISOString() },
      meta: { actor: { type: 'api_key', id: 'key_jane' } },
    })
    const start = clock.now()
    await record(tenant, claimed(tenant, 'case_1'))
    clock.advance(60_000)
    await record(tenant, decided('case_1', 'u_john_doe'))
    await record(tenant, { id: `evt_${++n}`, type: 'action.requested', data: { tenant, actionRequestId: 'acr_1', caseId: 'case_1', actionKey: 'warn', subjectExternalId: 'u_john_doe' } })
    clock.advance(60_000)
    await record(tenant, claimed(tenant, 'case_2', 'key_john'))

    const seqs = async (query: Partial<AuditQuery>) => (await search(tenant, query)).data.map((e) => e.seq)
    expect(await seqs({ caseId: 'case_1' })).toEqual([1, 2, 3])
    expect(await seqs({ subjectExternalId: 'u_john_doe' })).toEqual([2, 3])
    expect(await seqs({ actorId: 'key_john' })).toEqual([4])
    expect(await seqs({ actorId: 'system' })).toEqual([3])
    expect(await seqs({ from: new Date(start.getTime() + 60_000), to: new Date(start.getTime() + 120_000) })).toEqual([2, 3])
    const page = await search(tenant, { limit: 3 })
    expect(page.nextAfterSeq).toBe(3)
    expect(await search(tenant, { limit: 3, afterSeq: 3 })).toMatchObject({ data: [{ seq: 4 }], nextAfterSeq: null })
  })

  it('lets the app role neither change nor delete an entry, but reports one changed behind its back', async () => {
    const tenant: TenantRef = { appId: 'app_e', livemode: true }
    for (let i = 0; i < 3; i++) await record(tenant, claimed(tenant, `case_${i}`))
    await expect(withTenant(db, scope(tenant), (tx) => tx.execute(sql`UPDATE audit.entries SET facts = '{}'`))).rejects.toThrow()
    await expect(withTenant(db, scope(tenant), (tx) => tx.execute(sql`DELETE FROM audit.entries`))).rejects.toThrow()
    await expect(withTenant(db, scope(tenant), (tx) => tx.execute(sql`INSERT INTO audit.checkpoints VALUES ('app_e', true, 1, ${'0'.repeat(64)}, now())`))).rejects.toThrow()

    await asSuperuser(`UPDATE audit.entries SET facts = '{"holder":"key_mallory"}' WHERE app_id = 'app_e' AND seq = 2`)
    expect(await verify(tenant)).toEqual({ ok: false, checked: 1, seq: 2, reason: 'hash_mismatch' })
    await asSuperuser(`DELETE FROM audit.entries WHERE app_id = 'app_e' AND seq = 2`)
    expect(await verify(tenant)).toEqual({ ok: false, checked: 1, seq: 3, reason: 'seq_gap' })
  })

  it('verifies from the checkpoint once old entries are purged', async () => {
    const tenant: TenantRef = { appId: 'app_f', livemode: true }
    const entries = []
    for (let i = 0; i < 3; i++) entries.push((await record(tenant, claimed(tenant, `case_${i}`)))!)
    await asSuperuser(`DELETE FROM audit.entries WHERE app_id = 'app_f' AND seq = 1`)
    expect(await verify(tenant)).toMatchObject({ ok: false, seq: 2, reason: 'seq_gap' })
    await asSuperuser(`INSERT INTO audit.checkpoints VALUES ('app_f', true, 1, '${entries[0]!.hash}', now())`)
    expect(await verify(tenant)).toEqual({ ok: true, checked: 2 })
  })

  it("erases an account from the entries found by it, and the chain still verifies", async () => {
    const tenant: TenantRef = { appId: 'app_x', livemode: true }
    const opened = (caseId: string, subject: string) => ({ id: `evt_${++n}`, type: 'case.opened', data: { caseId, reportId: `rpt_${caseId}`, subjectExternalId: subject, band: 'standard', occurredAt: clock.now().toISOString() } })
    await record(tenant, opened('case_x1', 'u_john_doe'))
    await record(tenant, opened('case_x2', 'u_jim_doe'))
    expect(await withTenant(db, scope(tenant), (tx) => pgAuditStore(tx).eraseAccount(tenant, 'u_john_doe', 'erased_ers_1'))).toBe(1)
    expect((await search(tenant, { subjectExternalId: 'u_john_doe' })).data).toEqual([])
    expect((await search(tenant, { subjectExternalId: 'erased_ers_1' })).data.map((e) => e.target.id)).toEqual(['case_x1'])
    expect((await search(tenant, { subjectExternalId: 'u_jim_doe' })).data).toHaveLength(1)
    expect(await verify(tenant)).toMatchObject({ ok: true, checked: 2 })
  })

  it('keeps tenants apart', async () => {
    const other = { appIds: ['app_b'], livemode: true }
    expect(await withTenant(db, other, (tx) => pgAuditStore(tx).search(A, { limit: 50 }))).toEqual({ data: [], nextAfterSeq: null })
  })
})
