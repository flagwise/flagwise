// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import type { TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfRef, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { intakeMigrations, intakeTables, pgReportStore, type Report, type ReportStore } from '../src/index.ts'

const A: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const T0 = new Date('2026-11-06T09:00:00.000Z')
const H = 3_600_000

const report = (id: string, over: Partial<Report> = {}): Report => ({
  id,
  tenant: A,
  reporterExternalId: 'u_jane_doe',
  reportedExternalId: 'u_john_doe',
  category: 'asking_for_money',
  snapshotKey: `apps/app_a/${id}`,
  idempotencyKey: null,
  requestHash: 'a'.repeat(64),
  receivedAt: T0,
  caseId: null,
  joinedExistingCase: null,
  ...over,
})

describe.skipIf(!testDatabaseUrl)('pgReportStore', () => {
  let t: TestDatabase
  let db: Database
  const inTenant = <R>(tenant: TenantRef, fn: (s: ReportStore) => Promise<R>) => withTenant(db, scopeOfRef(tenant), (tx) => fn(pgReportStore(tx)))

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [intakeMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, intakeTables)).toEqual([])
  })

  it('reads back what it wrote, and records the case only once', async () => {
    const r = report('rpt_1')
    expect(await inTenant(A, (s) => s.insert(r, new Date(T0.getTime() - 24 * H)))).toBe(true)
    expect(await inTenant(A, (s) => s.findById(A, 'rpt_1'))).toEqual(r)
    expect(await inTenant(A, (s) => s.setCase(A, 'rpt_1', 'case_1', false))).toBe(true)
    expect(await inTenant(A, (s) => s.setCase(A, 'rpt_1', 'case_2', true))).toBe(false)
    expect(await inTenant(A, (s) => s.findById(A, 'rpt_1'))).toEqual({ ...r, caseId: 'case_1', joinedExistingCase: false })
    expect(await inTenant(A, (s) => s.setCase(A, 'rpt_nope', 'case_1', false))).toBe(false)
  })

  it('holds an idempotency key for its window, then hands it over', async () => {
    const since = new Date(T0.getTime() - 24 * H)
    const first = report('rpt_k1', { idempotencyKey: 'key-1' })
    await inTenant(A, (s) => s.insert(first, since))
    expect(await inTenant(A, (s) => s.insert(report('rpt_k2', { idempotencyKey: 'key-1' }), since))).toBe(false)
    expect(await inTenant(A, (s) => s.findById(A, 'rpt_k2'))).toBeNull()
    expect(await inTenant(A, (s) => s.findByIdempotencyKey(A, 'key-1', since))).toEqual(first)
    // Another mode is another key space.
    const test = { ...A, livemode: false }
    expect(await inTenant(test, (s) => s.insert(report('rpt_k3', { tenant: test, idempotencyKey: 'key-1' }), since))).toBe(true)
    // A day later the first report's key has expired.
    const later = new Date(T0.getTime() + H)
    const next = report('rpt_k4', { idempotencyKey: 'key-1', receivedAt: new Date(T0.getTime() + 25 * H) })
    expect(await inTenant(A, (s) => s.findByIdempotencyKey(A, 'key-1', later))).toBeNull()
    expect(await inTenant(A, (s) => s.insert(next, later))).toBe(true)
    expect(await inTenant(A, (s) => s.findById(A, 'rpt_k1'))).toEqual({ ...first, idempotencyKey: null })
    expect(await inTenant(A, (s) => s.findByIdempotencyKey(A, 'key-1', later))).toEqual(next)
  })

  it('makes a concurrent insert with the same key wait, then refuses it', async () => {
    const since = new Date(T0.getTime() - 24 * H)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let firstInserted!: () => void
    const inserted = new Promise<void>((r) => (firstInserted = r))
    const first = inTenant(A, async (s) => {
      await s.insert(report('rpt_c1', { idempotencyKey: 'key-c' }), since)
      firstInserted()
      await held
    })
    await inserted
    let secondDone = false
    const second = inTenant(A, (s) => s.insert(report('rpt_c2', { idempotencyKey: 'key-c' }), since)).finally(() => (secondDone = true))
    await new Promise((r) => setTimeout(r, 200))
    expect(secondDone).toBe(false)
    release()
    await first
    expect(await second).toBe(false)
    expect(await inTenant(A, (s) => s.findByIdempotencyKey(A, 'key-c', since))).toMatchObject({ id: 'rpt_c1' })
  })

  it('keeps tenants apart', async () => {
    await inTenant(A, (s) => s.insert(report('rpt_t1'), T0))
    const B = { ...A, appId: 'app_b' }
    expect(await inTenant(B, (s) => s.findById(A, 'rpt_t1'))).toBeNull()
    expect(await inTenant(B, (s) => s.setCase(A, 'rpt_t1', 'case_x', false))).toBe(false)
    await expect(inTenant(B, (s) => s.insert(report('rpt_t2'), T0))).rejects.toThrow()
  })
})
