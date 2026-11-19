// Upgrading to triage's own record of each case: the cases moderation already held that triage may
// still triage start from moderation's tables, with the classification each was triaged on. Runs
// against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { moderationMigrations, pgCaseRepository } from '@flagwise/moderation'
import type { TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfRef, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { pgTriageCaseStore, triageMigrations } from '@flagwise/triage'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const A: TenantRef = { orgId: 'org_jane', appId: 'app_jane', livemode: true }
const T0 = new Date('2026-11-19T09:00:00.000Z')
const triage = { severity: 'P1' as const, priority: 2000, slaDueAt: T0, suggestedActionKeys: [] }

describe.skipIf(!testDatabaseUrl)('upgrading to triage records', () => {
  let t: TestDatabase
  let db: Database

  beforeAll(async () => {
    t = await createTestDatabase()
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('starts from the cases moderation held, leaving decided ones out, with forced row-level security back on', async () => {
    // A release before: moderation's cases, and triage with only its policy copies.
    await migrate(t.ownerUrl, [moderationMigrations, { ...triageMigrations, migrations: triageMigrations.migrations.slice(0, 1) }], t.roles)
    await withTenant(db, scopeOfRef(A), async (tx) => {
      const repo = pgCaseRepository(tx)
      const base = { tenant: A, subjectExternalId: 'u_john_doe', band: 'standard' as const, openedAt: T0 }
      const classification = { categoryId: 'scams_fraud.romance_scam', customCategoryId: 'asking_for_money', signals: ['minor_involved'], injectionSuspected: false, classifiedBy: 'rules' as const }
      await repo.insert({ ...base, id: 'case_open', state: 'open', reportIds: ['rpt_1', 'rpt_2'], triage, classification })
      // What that release kept of the reports' account facts.
      await tx.execute(sql`UPDATE cases.case_reports SET reporter_external_id = 'u_jane_doe', reported_account_created_at = ${T0.toISOString()} WHERE report_id = 'rpt_2'`)
      await repo.insert({ ...base, id: 'case_waiting', state: 'claimed', reportIds: ['rpt_3'], claim: { memberId: 'mem_jane', claimedAt: T0, lastActivityAt: T0 } })
      await repo.insert({ ...base, id: 'case_done', state: 'actioned', reportIds: ['rpt_4'] })
    })
    await migrate(t.ownerUrl, [moderationMigrations, triageMigrations], t.roles)
    expect((await db.system.execute(sql`SELECT 1 FROM platform.consumer_groups WHERE name = 'triage'`)).rows).toEqual([])
    const records = await withTenant(db, scopeOfRef(A), async (tx) => {
      const store = pgTriageCaseStore(tx)
      // One after another: the queries share the transaction's connection.
      return [await store.find(A, 'case_open'), await store.find(A, 'case_waiting'), await store.find(A, 'case_done')]
    })
    expect(records[0]).toMatchObject({
      openedAt: T0,
      reportIds: ['rpt_1', 'rpt_2'],
      reports: [{ reportId: 'rpt_2', reporterExternalId: 'u_jane_doe', reporterAccountCreatedAt: null, reportedAccountCreatedAt: T0 }],
      state: 'triaged',
      classification: { categoryId: 'scams_fraud.romance_scam', customCategoryId: 'asking_for_money', signals: ['minor_involved'], injectionSuspected: false, preRuleP0: false, classifiedBy: 'rules' },
      claimed: false,
    })
    expect(records[1]).toMatchObject({ state: 'untriaged', classification: null, claimed: true, everClaimed: true })
    expect(records[2]).toBeNull()
    const forced = await withTenant(db, scopeOfRef(A), (tx) =>
      tx.execute<{ relname: string; relforcerowsecurity: boolean }>(sql`SELECT relname, relforcerowsecurity FROM pg_class WHERE relnamespace IN ('cases'::regnamespace, 'triage'::regnamespace) AND relkind = 'r'`),
    )
    expect(forced.rows.every((r) => r.relforcerowsecurity)).toBe(true)
  })

  it("queues for triage the classifications moderation's group had not handled yet", async () => {
    const u = await createTestDatabase()
    const udb = createDatabase({ appUrl: u.appUrl, systemUrl: u.systemUrl })
    try {
      // A release before: triage with only its policy copies, and moderation's group that triaged cases itself.
      await migrate(u.ownerUrl, [moderationMigrations, { ...triageMigrations, migrations: triageMigrations.migrations.slice(0, 1) }], u.roles)
      const event = (id: string, type: string, fannedOut: boolean) =>
        withTenant(udb, scopeOfRef(A), (tx) =>
          tx.execute<{ seq: string }>(sql`
            INSERT INTO platform.events (id, type, key, data, org_id, app_id, livemode, fanned_out)
            VALUES (${id}, ${type}, 'case_1', '{}', ${A.orgId}, ${A.appId}, true, ${fannedOut}) RETURNING seq`),
        )
      await udb.system.execute(sql`
        INSERT INTO platform.consumer_groups (name, types, max_attempts, since_seq)
        VALUES ('cases.triage', ARRAY['case.classified.v1'], 5, 0), ('classify', ARRAY['case.opened.v1'], 5, 0)`)
      const opened = (await event('case.opened:case_1', 'case.opened.v1', true)).rows[0]!.seq
      const classified = (await event('case.classified:case_1', 'case.classified.v1', true)).rows[0]!.seq
      const later = (await event('case.claimed:case_1:evt_1', 'case.claimed.v1', false)).rows[0]!.seq
      await udb.system.execute(sql`
        INSERT INTO platform.deliveries (group_name, seq, key) VALUES ('classify', ${opened}, 'case_1'), ('cases.triage', ${classified}, 'case_1')`)

      await migrate(u.ownerUrl, [moderationMigrations, triageMigrations], u.roles)
      const queued = await udb.system.execute<{ seq: string }>(sql`SELECT seq FROM platform.deliveries WHERE group_name = 'triage'`)
      expect(queued.rows.map((r) => r.seq)).toEqual([classified])
      // Events not fanned out yet reach triage's group too.
      const group = await udb.system.execute<{ since_seq: string }>(sql`SELECT since_seq FROM platform.consumer_groups WHERE name = 'triage'`)
      expect(BigInt(group.rows[0]!.since_seq)).toBeLessThan(BigInt(later))
      const forced = await udb.system.execute<{ relforcerowsecurity: boolean }>(sql`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'platform.events'::regclass`)
      expect(forced.rows[0]!.relforcerowsecurity).toBe(true)
    } finally {
      await udb.close()
      await u.drop()
    }
  })
})
