// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import type { TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, scopeOfRef, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deliveryMigrations,
  pgActionRequestStore,
  requestActions,
  retryFailedActions,
  settleAction,
  type ActionRequestStore,
  type DeliveryEvent,
} from '../src/index.ts'

const A: TenantRef = { orgId: 'org_a', appId: 'app_a', livemode: true }
const FACTS = { subjectExternalId: 'u_jane_doe', categoryId: 'scams_fraud.romance_scam', severity: 'P1', requestedBy: { type: 'member', id: 'mem_jane' } } as const

describe.skipIf(!testDatabaseUrl)('retryFailedActions', () => {
  let t: TestDatabase
  let db: Database
  let n = 0
  const inTx = <R>(fn: (store: ActionRequestStore) => Promise<R>) => withTenant(db, scopeOfRef(A), (tx) => fn(pgActionRequestStore(tx)))
  const deps = (requests: ActionRequestStore, events: DeliveryEvent[]) => ({
    requests,
    events: { publish: async (e: DeliveryEvent) => void events.push(e) },
    newActionRequestId: () => `acr_r${++n}`,
  })
  const decide = (decisionId: string, actionKeys: string[], events: DeliveryEvent[]) =>
    inTx((s) => requestActions(deps(s, events), { tenant: A, caseId: `case_${decisionId}`, decisionId, actionKeys, ...FACTS }))
  const settle = (id: string, status: 'confirmed' | 'failed', events: DeliveryEvent[]) =>
    inTx((s) => settleAction(deps(s, events), { tenant: A, actionRequestId: id, status, failReason: 'user not found' }))
  const retry = (decisionId: string, actionKeys: string[], events: DeliveryEvent[], retryId = 'retry_1', replaces?: string[]) =>
    inTx((s) =>
      retryFailedActions(deps(s, events), {
        tenant: A,
        caseId: `case_${decisionId}`,
        decisionId,
        actionKeys,
        ...FACTS,
        requestedBy: { type: 'api_key', id: 'key_admin' },
        retryId,
        ...(replaces && { replaces }),
      }),
    )

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [deliveryMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('replaces the failed requests, and the decision is confirmed by the new ones', async () => {
    const events: DeliveryEvent[] = []
    const [ban, hide] = await decide('dec_1', ['ban', 'hide_content'], events)
    await settle(ban!.id, 'failed', events)
    await settle(hide!.id, 'confirmed', events)
    events.length = 0

    const created = await retry('dec_1', ['suspend_7d'], events)
    expect(created).toEqual([expect.objectContaining({ actionKey: 'suspend_7d', status: 'pending', retryId: 'retry_1', replacedBy: null })])
    expect(await inTx((s) => s.findById(A, ban!.id))).toMatchObject({ status: 'failed', replacedBy: 'retry_1' })
    expect(events).toEqual([
      expect.objectContaining({ type: 'action.requested', actionKey: 'suspend_7d', replaces: [ban!.id], requestedBy: { type: 'api_key', id: 'key_admin' } }),
    ])
    expect((await inTx((s) => s.findByDecision(A, 'dec_1'))).map((r) => r.actionKey)).toEqual(['ban', 'hide_content', 'suspend_7d'])

    events.length = 0
    await settle(created[0]!.id, 'confirmed', events)
    expect(events.map((e) => e.type)).toEqual(['action.confirmed', 'decision.actions_confirmed'])
  })

  it('accepts the failures with an empty retry once the rest is confirmed', async () => {
    const events: DeliveryEvent[] = []
    const [warn, ban] = await decide('dec_2', ['warn', 'ban'], events)
    await settle(ban!.id, 'failed', events)
    events.length = 0
    expect(await retry('dec_2', [], events)).toEqual([])
    expect(events).toEqual([])
    await settle(warn!.id, 'confirmed', events)
    expect(events.map((e) => e.type)).toEqual(['action.confirmed', 'decision.actions_confirmed'])
  })

  it('confirms the decision at once when nothing else is pending', async () => {
    const events: DeliveryEvent[] = []
    const [ban] = await decide('dec_3', ['ban'], events)
    await settle(ban!.id, 'failed', events)
    events.length = 0
    await retry('dec_3', [], events)
    expect(events).toEqual([{ type: 'decision.actions_confirmed', tenant: A, caseId: 'case_dec_3', decisionId: 'dec_3' }])
  })

  it('replaces only failures not answered by an earlier retry', async () => {
    const events: DeliveryEvent[] = []
    const [ban] = await decide('dec_4', ['ban'], events)
    await settle(ban!.id, 'failed', events)
    const [again] = await retry('dec_4', ['ban'], events, 'retry_a')
    await settle(again!.id, 'failed', events)
    events.length = 0
    await retry('dec_4', ['warn'], events, 'retry_b')
    expect(events).toEqual([expect.objectContaining({ actionKey: 'warn', replaces: [again!.id] })])
    expect(await inTx((s) => s.findById(A, ban!.id))).toMatchObject({ replacedBy: 'retry_a' })
  })

  it('replaces only the failures the retry names, so a failure moderation had not heard of waits for another answer', async () => {
    const events: DeliveryEvent[] = []
    const [ban, hide] = await decide('dec_5', ['ban', 'hide_content'], events)
    await settle(ban!.id, 'failed', events)
    await settle(hide!.id, 'failed', events)
    events.length = 0
    await retry('dec_5', ['suspend_7d'], events, 'retry_5', [ban!.id])
    expect(events).toEqual([expect.objectContaining({ actionKey: 'suspend_7d', replaces: [ban!.id] })])
    expect(await inTx((s) => s.findById(A, hide!.id))).toMatchObject({ status: 'failed', replacedBy: null })
  })

  it('carries out a retry once, however often its event comes', async () => {
    const events: DeliveryEvent[] = []
    const [ban] = await decide('dec_6', ['ban'], events)
    await settle(ban!.id, 'failed', events)
    events.length = 0
    await retry('dec_6', ['warn'], events, 'retry_6', [ban!.id])
    expect(await retry('dec_6', ['warn'], events, 'retry_6', [ban!.id])).toEqual([])
    expect(events.map((e) => e.type)).toEqual(['action.requested'])
    expect(await inTx((s) => s.findByDecision(A, 'dec_6'))).toHaveLength(2)
  })
})
