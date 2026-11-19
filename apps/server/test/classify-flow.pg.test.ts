// A report through flagging and the services of the core loop on Postgres, with classify on a
// scripted LLM. Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { manualClock, type AppRef } from '@flagwise/kernel'
import { eventContract } from '@flagwise/contracts'
import { createDatabase, createPgBus, memoryStorage, migrate, pgUnitOfWork, scopeOfApp, withApps, type Database, type PgBus } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { moderationMigrations, pgCaseRepository, pgModerationPolicyCopy } from '@flagwise/moderation'
import {
  classifierPrompt,
  classifyDepsWithPolicy,
  classifyMigrations,
  findClassification,
  pgClassifyPolicyCopy,
  pgClassifyRunner,
  type ClassifyDeps,
  type LlmProvider,
  type LlmRequest,
} from '@flagwise/classify'
import { deliveryMigrations, pgDeliveryDeps } from '@flagwise/delivery'
import { flaggingMigrations, pgFlaggingRunner, submitReport, type FlaggingDeps } from '@flagwise/flagging'
import { pgTriageDeps, triageMigrations } from '@flagwise/triage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeServices } from './support/services.ts'

const A: AppRef = { appId: 'app_a', livemode: true }

const report = (text: string) =>
  JSON.stringify({
    reporter: { external_id: 'u_jane_doe' },
    reported: { external_id: `u_john_doe_${text.length}` },
    category: 'asking_for_money',
    text,
    evidence: { kind: 'message', content: ['can you send me $200 first? mail me at john.doe@example.com'] },
  })

describe.skipIf(!testDatabaseUrl)('classify in the core loop on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  let flagging: FlaggingDeps
  let classify: ClassifyDeps
  const requests: LlmRequest[] = []
  let answers: unknown[] = []
  let n = 0
  const llm: LlmProvider = {
    async complete(request) {
      requests.push(request)
      return { json: answers.shift(), usage: { input: 1000, output: 100, cached: 2000 }, model: request.model }
    },
  }
  const caseOf = (id: string) => withApps(db, scopeOfApp(A), (tx) => pgCaseRepository(tx).findById(A, id))
  const send = async (text: string) => {
    const { report: r } = await submitReport(flagging, { appRef: A, body: report(text) })
    await bus.drain()
    const caseId = (await bus.log()).map((l) => l.event).find((e) => e.type === 'case.opened.v1' && (e.data as { reportId: string }).reportId === r.id)!.key
    return caseId
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [flaggingMigrations, moderationMigrations, deliveryMigrations, classifyMigrations, triageMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { retryDelayMs: () => 0, contract: eventContract })
    const clock = manualClock('2026-11-06T09:00:00Z')
    const storage = memoryStorage()
    flagging = { run: pgFlaggingRunner(db, bus), storage, clock, newReportId: () => `rpt_${++n}` }
    const policy = pgClassifyPolicyCopy(db)
    classify = classifyDepsWithPolicy(
      {
        run: pgClassifyRunner(db),
        snapshots: storage,
        clock,
        llm: { provider: llm, model: 'claude-haiku-5-5', escalationModel: 'claude-sonnet-5-5', prompt: classifierPrompt('You classify user reports.') },
        redact: true,
      },
      policy,
    )
    composeServices({
      bus,
      clock,
      newCaseId: () => `case_${++n}`,
      newDecisionId: () => `dec_${++n}`,
      newActionRequestId: () => `acr_${++n}`,
      newEventId: () => `evt_${++n}`,
      cases: { uow: pgUnitOfWork(db, bus, (tx) => ({ cases: pgCaseRepository(tx) })), policy: pgModerationPolicyCopy(db) },
      delivery: pgDeliveryDeps(db, bus, { clock, newActionRequestId: () => `acr_${++n}`, newEventId: () => `evt_${++n}` }),
      triage: pgTriageDeps(db, bus),
      classify: { classify, policy },
    })
    await bus.drain()
  })
  afterAll(async () => {
    await bus?.stop()
    await db?.close()
    await t?.drop()
  })

  it('classifies a new case with the LLM on redacted evidence and triages it', async () => {
    answers = [
      { category_id: 'scams_fraud.romance_scam', custom_category_id: null, confidence: 0.9, signals: ['asking_for_money'], summary: 'Asked for $200.', injection_suspected: false },
    ]
    const caseId = await send('He wants money')
    expect(requests.at(-1)!.input).toContain('[EMAIL]')
    expect(requests.at(-1)!.input).not.toContain('john.doe@example.com')
    expect(await caseOf(caseId)).toMatchObject({ state: 'open', triage: { severity: 'P1', suggestedActionKeys: [] } })
    expect(await findClassification(classify, A, caseId)).toMatchObject({ classifiedBy: 'llm', summary: 'Asked for $200.', model: 'claude-haiku-5-5' })
    // The event carries the facts triage needs, never the summary.
    const classified = (await bus.log()).map((l) => l.event).find((e) => e.type === 'case.classified.v1' && e.key === caseId)!
    expect(classified.data).toMatchObject({ categoryId: 'scams_fraud.romance_scam', classifiedBy: 'llm', preRuleP0: false })
    expect(JSON.stringify(classified.data)).not.toContain('Asked for $200.')
    expect(await bus.deadLetters()).toEqual([])
  })

  it('keeps a pre-rule P0 the LLM missed, so triage makes the case P0', async () => {
    answers = [
      { category_id: 'scams_fraud.romance_scam', custom_category_id: null, confidence: 0.9, signals: [], summary: 'Asked for money.', injection_suspected: false },
      { category_id: 'child_safety.underage_user', custom_category_id: null, confidence: 0.85, signals: [], summary: 'The reporter is 14.', injection_suspected: false },
    ]
    const caseId = await send("I'm 14 and he wants money")
    // The P0 signal escalated the case to the stronger model.
    expect(requests.at(-1)!.model).toBe('claude-sonnet-5-5')
    expect(await caseOf(caseId)).toMatchObject({ triage: { severity: 'P0' } })
    expect(await findClassification(classify, A, caseId)).toMatchObject({ signals: ['minor_involved'], preRuleP0: true, escalated: true })
  })
})
