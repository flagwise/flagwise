// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import type { AppRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfApp, withApps, type Database } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deliveryMigrations,
  deliveryTables,
  pgActionRequestStore,
  requestActions,
  settleAction,
  type ActionRequestStore,
  type DeliveryEvent,
} from '../src/index.ts'

const A: AppRef = { appId: 'app_a', livemode: true }
const B: AppRef = { appId: 'app_b', livemode: true }
const FACTS = { subjectExternalId: 'u_5531', categoryId: 'scams_fraud.romance_scam', severity: 'P1', requestedBy: { type: 'member', id: 'mem_jane' } } as const

describe.skipIf(!testDatabaseUrl)('pgActionRequestStore', () => {
  let t: TestDatabase
  let db: Database
  let n = 0
  const inTx = <R>(appRef: AppRef, fn: (store: ActionRequestStore) => Promise<R>) => withApps(db, scopeOfApp(appRef), (tx) => fn(pgActionRequestStore(tx)))
  const deps = (requests: ActionRequestStore, events: DeliveryEvent[]) => ({
    requests,
    events: { publish: async (e: DeliveryEvent) => void events.push(e) },
    newActionRequestId: () => `acr_${++n}`,
  })

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [deliveryMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, deliveryTables)).toEqual([])
  })

  it('creates requests in order once per decision, and keeps appRefs apart', async () => {
    const events: DeliveryEvent[] = []
    const decision = { appRef: A, caseId: 'case_1', decisionId: 'dec_1', actionKeys: ['suspend_7d', 'hide_content'], ...FACTS }
    const created = await inTx(A, (s) => requestActions(deps(s, events), decision))
    expect(await inTx(A, (s) => requestActions(deps(s, events), decision))).toEqual(created)
    expect((await inTx(A, (s) => s.findByDecision(A, 'dec_1'))).map((r) => r.actionKey)).toEqual(['suspend_7d', 'hide_content'])
    expect(events.map((e) => e.type)).toEqual(['action.requested', 'action.requested'])
    expect(await inTx(B, (s) => s.findById(B, created[0]!.id))).toBeNull()
    expect(await inTx(B, (s) => s.findById(A, created[0]!.id))).toBeNull()
  })

  it('publishes "all confirmed" exactly once when the last two requests are confirmed at once', async () => {
    const events: DeliveryEvent[] = []
    const created = await inTx(A, (s) => requestActions(deps(s, events), { appRef: A, caseId: 'case_2', decisionId: 'dec_2', actionKeys: ['warn', 'ban'], ...FACTS }))
    // Each confirmation, after reading the decision's requests, waits until both have read them
    // (released together), or 200 ms: without the decision lock both would read the other request
    // as still pending, and neither would publish.
    const waiting: (() => void)[] = []
    const together = () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve)
        if (waiting.length >= 2) waiting.forEach((r) => r())
        else setTimeout(resolve, 200)
      })
    const racing = (s: ActionRequestStore): ActionRequestStore => ({
      ...s,
      findByDecision: async (appRef, decisionId) => {
        const found = await s.findByDecision(appRef, decisionId)
        await together()
        return found
      },
    })
    await Promise.all(created.map((r) => inTx(A, (s) => settleAction(deps(racing(s), events), { appRef: A, actionRequestId: r.id, status: 'confirmed' }))))
    expect(events.filter((e) => e.type === 'action.confirmed')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'decision.actions_confirmed')).toEqual([
      { type: 'decision.actions_confirmed', appRef: A, caseId: 'case_2', decisionId: 'dec_2' },
    ])
  })

  it('settles a request once, and refuses an unknown one', async () => {
    const events: DeliveryEvent[] = []
    const [r] = await inTx(A, (s) => requestActions(deps(s, events), { appRef: A, caseId: 'case_3', decisionId: 'dec_3', actionKeys: ['warn'], ...FACTS }))
    await inTx(A, (s) => settleAction(deps(s, events), { appRef: A, actionRequestId: r!.id, status: 'failed', failReason: 'user not found' }))
    await inTx(A, (s) => settleAction(deps(s, events), { appRef: A, actionRequestId: r!.id, status: 'confirmed' }))
    expect(await inTx(A, (s) => s.findById(A, r!.id))).toMatchObject({ status: 'failed', failReason: 'user not found' })
    expect(events.map((e) => e.type)).toEqual(['action.requested', 'action.failed'])
    await expect(inTx(A, (s) => settleAction(deps(s, events), { appRef: A, actionRequestId: 'acr_nope', status: 'confirmed' }))).rejects.toThrow('No action request acr_nope')
  })
})
