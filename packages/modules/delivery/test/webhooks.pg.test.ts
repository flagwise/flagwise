// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { FlagwiseError, manualClock, type TenantRef } from '@flagwise/kernel'
import { createDatabase, migrate, newKeyringEntry, parseKeyring, scopeOfRef, withSystem, withTenant, type Database } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { sql, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addEndpoint,
  deliveryMigrations,
  enqueueWebhook,
  keyringSealer,
  pgWebhookOutbox,
  pgWebhookStore,
  removeEndpoint,
  resealWebhookSecrets,
  rollSecret,
  sendDueWebhooks,
  verify,
  type InternalEvent,
  type PostResult,
  type WebhookDeps,
} from '../src/index.ts'

const K1 = newKeyringEntry('k1', () => new Uint8Array(32).fill(1))
const K2 = newKeyringEntry('k2', () => new Uint8Array(32).fill(2))

const TRIAGED: InternalEvent = {
  type: 'case.triaged',
  caseId: 'case_1',
  reportIds: ['rpt_1'],
  categoryId: 'scams_fraud.romance_scam',
  severity: 'P1',
  priority: 2000,
  slaDueAt: new Date('2026-11-12T09:00:00Z'),
  suggestedActionKeys: [],
  signals: [],
  injectionSuspected: false,
  classifiedBy: 'llm',
  summary: 'never sent',
}

interface Posted {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

describe.skipIf(!testDatabaseUrl)('webhooks on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let tenantN = 0
  let idN = 0
  let tenant: TenantRef
  const clock = manualClock('2026-11-11T09:00:00Z')
  let sealer = keyringSealer(parseKeyring(K1))
  let posted: Posted[]
  let answer: (p: Posted) => PostResult

  const deps = (store: ReturnType<typeof pgWebhookStore>): WebhookDeps => ({
    webhooks: store,
    sealer,
    clock,
    newEventId: () => `evt_${++idN}`,
    newEndpointId: () => `whe_${++idN}`,
    newSecret: () => `whsec_${Buffer.alloc(32, ++idN).toString('base64')}`,
  })
  const inTenant = <R>(fn: (d: WebhookDeps) => Promise<R>, ref = tenant) => withTenant(db, scopeOfRef(ref), (tx) => fn(deps(pgWebhookStore(tx))))
  /** Posts of the current tenant, so deliveries left by other tests (the outbox spans tenants) do not count. */
  const mine = (p: Posted) => (JSON.parse(p.body) as { app_id: string }).app_id === tenant.appId
  /** One sender round; returns how many of the current tenant's deliveries it posted. */
  const send = async () => {
    const before = posted.filter(mine).length
    await sendDueWebhooks({
      outbox: { leaseDue: (now, o) => withSystem(db, (tx) => pgWebhookOutbox(tx).leaseDue(now, o)) },
      inTenant: (ref, fn) => withTenant(db, scopeOfRef(ref), (tx) => fn(pgWebhookStore(tx))),
      sealer,
      clock,
      post: async (url, req) => {
        const p = { url, ...req }
        if (mine(p)) posted.push(p)
        return answer(p)
      },
    })
    return posted.filter(mine).length - before
  }
  /** Rows of a query in the current tenant's transaction, so row-level security lets them through. */
  const rows = async (query: SQL) => (await withTenant(db, scopeOfRef(tenant), (tx) => tx.execute(query))).rows as Record<string, unknown>[]
  const deliveryRow = (eventId: string) => rows(sql`SELECT status, attempts, next_attempt_at FROM delivery.webhook_deliveries WHERE event_id = ${eventId}`)

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [deliveryMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })
  beforeEach(() => {
    tenant = { orgId: 'org_jane', appId: `app_${++tenantN}`, livemode: true }
    sealer = keyringSealer(parseKeyring(K1))
    posted = []
    answer = () => ({ status: 200 })
    clock.set('2026-11-11T09:00:00Z')
  })

  describe('endpoints and secrets', () => {
    it('makes the first secret with the first endpoint, once, and stores it sealed', async () => {
      const first = await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com/flagwise' }))
      expect(first.secret).toMatch(/^whsec_/)
      expect(first.endpoint.eventTypes).toBeNull()
      const second = await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com/b', eventTypes: ['action.requested'] }))
      expect(second.secret).toBeUndefined()
      const stored = await inTenant((d) => d.webhooks.secrets(tenant))
      expect(stored).toHaveLength(1)
      expect(stored[0]!.sealed).toMatch(/^v1\.k1\./)
      expect(stored[0]!.sealed).not.toContain(first.secret!.slice(6))
    })

    it('refuses bad URLs and event types, and a fourth endpoint', async () => {
      const refused = async (input: Parameters<typeof addEndpoint>[2]) => {
        const err = await inTenant((d) => addEndpoint(d, tenant, input)).catch((e) => e)
        expect(err).toBeInstanceOf(FlagwiseError)
        return (err as FlagwiseError).code
      }
      expect(await refused({ url: 'http://hooks.example.com' })).toBe('validation_failed')
      expect(await refused({ url: 'https://jane:pw@hooks.example.com' })).toBe('validation_failed')
      expect(await refused({ url: 'not a url' })).toBe('validation_failed')
      expect(await refused({ url: 'https://hooks.example.com', eventTypes: [] })).toBe('validation_failed')
      expect(await refused({ url: 'https://hooks.example.com', eventTypes: ['case.opened'] })).toBe('validation_failed')
      for (let i = 0; i < 3; i++) await inTenant((d) => addEndpoint(d, tenant, { url: `https://hooks.example.com/${i}` }))
      expect(await refused({ url: 'https://hooks.example.com/4' })).toBe('conflict')
    })

    it('keeps the old secret signing during the overlap of a roll', async () => {
      const { secret: old } = await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com' }))
      const rolled = await inTenant((d) => rollSecret(d, tenant, { overlapMs: 3_600_000 }))
      expect(rolled.version).toBe(2)
      expect(rolled.previousExpireAt).toEqual(new Date('2026-11-11T10:00:00Z'))

      await inTenant((d) => enqueueWebhook(d, tenant, { sourceId: 'case.triaged:case_1', event: TRIAGED }))
      expect(await send()).toBe(1)
      const p = posted[0]!
      expect(verify(old!, p.headers, p.body, { clock }).ok).toBe(true)
      expect(verify(rolled.secret, p.headers, p.body, { clock }).ok).toBe(true)

      clock.advance(3_600_000)
      await inTenant((d) => enqueueWebhook(d, tenant, { sourceId: 'case.triaged:case_2', event: { ...TRIAGED, caseId: 'case_2' } }))
      await send()
      const after = posted[1]!
      expect(verify(old!, after.headers, after.body, { clock }).ok).toBe(false)
      expect(verify(rolled.secret, after.headers, after.body, { clock }).ok).toBe(true)
    })

    it('refuses an overlap over 7 days', async () => {
      const err = await inTenant((d) => rollSecret(d, tenant, { overlapMs: 8 * 86_400_000 })).catch((e) => e)
      expect((err as FlagwiseError).code).toBe('validation_failed')
    })
  })

  describe('fan-out', () => {
    it('stores one event per internal event and one delivery per endpoint whose filter takes it', async () => {
      await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com/all' }))
      await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com/actions', eventTypes: ['action.requested'] }))
      const input = { sourceId: 'case.triaged:case_1', event: TRIAGED }
      expect(await inTenant((d) => enqueueWebhook(d, tenant, input))).toBe(1)
      expect(await inTenant((d) => enqueueWebhook(d, tenant, input))).toBe(1)
      expect(await send()).toBe(1)
      const body = JSON.parse(posted[0]!.body)
      expect(body).toMatchObject({ type: 'report.triaged', app_id: tenant.appId, livemode: true, api_version: '2026-11-01' })
      expect(body.data.case_id).toBe('case_1')
      expect(posted[0]!.body).not.toContain('never sent')
      expect(posted[0]!.headers['webhook-id']).toBe(body.id)
    })

    it('stores nothing for an event no endpoint takes, or tenants never see', async () => {
      await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com', eventTypes: ['action.requested'] }))
      expect(await inTenant((d) => enqueueWebhook(d, tenant, { sourceId: 'x', event: TRIAGED }))).toBe(0)
      expect(await inTenant((d) => enqueueWebhook(d, tenant, { sourceId: 'y', event: { type: 'case.opened', caseId: 'case_1' } }))).toBe(0)
      expect(await send()).toBe(0)
    })

    it('keeps tenants apart', async () => {
      const other: TenantRef = { ...tenant, livemode: false }
      await inTenant((d) => addEndpoint(d, other, { url: 'https://test-hooks.example.com' }), other)
      expect(await inTenant((d) => enqueueWebhook(d, tenant, { sourceId: 's', event: TRIAGED }))).toBe(0)
      expect(await inTenant((d) => d.webhooks.endpoints(tenant))).toEqual([])
    })
  })

  describe('sending', () => {
    const enqueue = async (sourceId = 'case.triaged:case_1') => {
      await inTenant((d) => enqueueWebhook(d, tenant, { sourceId, event: TRIAGED }))
      const [row] = await rows(sql`SELECT id FROM delivery.webhook_events WHERE source_id = ${sourceId}`)
      return row!.id as string
    }

    it('retries on the schedule, then fails after the eighth attempt', async () => {
      await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com' }))
      answer = () => ({ status: 500 })
      const eventId = await enqueue()
      expect(await send()).toBe(1)
      expect(await deliveryRow(eventId)).toMatchObject([{ status: 'pending', attempts: 1 }])
      expect(await send()).toBe(0)
      for (const delay of [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000]) {
        clock.advance(delay)
        expect(await send()).toBe(1)
      }
      expect(await deliveryRow(eventId)).toMatchObject([{ status: 'failed', attempts: 8, next_attempt_at: null }])
      expect(posted).toHaveLength(8)
    })

    it('counts a timeout or no response as a failed attempt', async () => {
      await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com' }))
      answer = () => ({ status: null, error: 'timeout' })
      const eventId = await enqueue()
      await send()
      expect(await rows(sql`SELECT status, error, delivered FROM delivery.webhook_attempts WHERE event_id = ${eventId}`)).toEqual([{ status: null, error: 'timeout', delivered: false }])
    })

    it('fails the pending deliveries of a removed endpoint', async () => {
      const { endpoint } = await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com' }))
      const eventId = await enqueue()
      await inTenant((d) => removeEndpoint(d, tenant, endpoint.id))
      expect(await send()).toBe(0)
      expect(await deliveryRow(eventId)).toMatchObject([{ status: 'failed' }])
      expect((await inTenant((d) => removeEndpoint(d, tenant, endpoint.id)).catch((e) => e)).code).toBe('not_found')
    })

    it('holds at most five deliveries per endpoint at once, and never sends one twice in a round', async () => {
      await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com' }))
      for (let i = 0; i < 7; i++) await enqueue(`case.triaged:case_${i}`)
      const lease = async () =>
        (await withSystem(db, (tx) => pgWebhookOutbox(tx).leaseDue(clock.now(), { limit: 50, leaseMs: 60_000, perEndpoint: 5 }))).filter((d) => d.tenant.appId === tenant.appId)
      expect(await lease()).toHaveLength(5)
      expect(await lease()).toEqual([])
      clock.advance(60_000)
      expect(await send()).toBe(5)
      expect(await send()).toBe(2)
      expect(new Set(posted.map((p) => p.headers['webhook-id'])).size).toBe(7)
    })
  })

  it('reseals every secret under a new master key, after which the old key can go', async () => {
    const { secret } = await inTenant((d) => addEndpoint(d, tenant, { url: 'https://hooks.example.com' }))
    sealer = keyringSealer(parseKeyring(`${K2},${K1}`))
    expect(await withSystem(db, (tx) => resealWebhookSecrets(tx, sealer))).toBeGreaterThanOrEqual(1)
    expect(await withSystem(db, (tx) => resealWebhookSecrets(tx, sealer))).toBe(0)
    sealer = keyringSealer(parseKeyring(K2))
    await inTenant((d) => enqueueWebhook(d, tenant, { sourceId: 'case.triaged:case_1', event: TRIAGED }))
    await send()
    expect(verify(secret!, posted[0]!.headers, posted[0]!.body, { clock }).ok).toBe(true)
  })
})
