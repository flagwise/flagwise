// Runs against a real Postgres through TEST_DATABASE_URL; skipped without it.
import { currentType, eventContract, notificationCleared, notificationRaised, type EventData } from '@flagwise/contracts'
import { manualClock, type AppRef, type ManualClock } from '@flagwise/kernel'
import { createDatabase, createPgBus, migrate, type BusEvent, type Database, type PgBus } from '@flagwise/platform'
import { createTestDatabase, schemaDrift, testDatabaseUrl, type TestDatabase } from '@flagwise/platform/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { notificationsMigrations, notificationsService, notificationsTables, pgNotificationsDeps, subscribeNotifications, type NotificationsService } from '../src/index.ts'

const A: AppRef = { appId: 'app_a', livemode: true }
const B: AppRef = { appId: 'app_b', livemode: true }
const MIN = 60_000

describe.skipIf(!testDatabaseUrl)('notifications on Postgres', () => {
  let t: TestDatabase
  let db: Database
  let bus: PgBus
  let clock: ManualClock
  let service: NotificationsService
  let n = 0
  const at = (min: number) => new Date(clock.now().getTime() + min * MIN)
  const publish = async (appRef: AppRef, ...events: Omit<BusEvent, 'appRef'>[]) => {
    await bus.publish(events.map((e) => ({ ...e, appRef })))
    await bus.drain()
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    await migrate(t.ownerUrl, [notificationsMigrations], t.roles)
    db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
    bus = createPgBus(db, { contract: eventContract, retryDelayMs: () => 0 })
    clock = manualClock('2026-11-20T09:00:00Z')
    const deps = pgNotificationsDeps(db, bus, { clock, newNotificationId: () => `ntf_${++n}` })
    subscribeNotifications(bus, deps)
    service = notificationsService(deps)
    await bus.drain()
  })
  afterAll(async () => {
    await db?.close()
    await t?.drop()
  })

  it('has tables that match the Drizzle schema', async () => {
    expect(await schemaDrift(t.ownerUrl, notificationsTables)).toEqual([])
  })

  it('keeps one notification per key from the raises and clears on the bus', async () => {
    await publish(A, notificationRaised('new_p0', 'case_1', { caseId: 'case_1' }, at(0)), notificationRaised('new_p0', 'case_1', { caseId: 'case_1' }, at(1)))
    await publish(A, notificationRaised('sla_75', 'case_2', { caseId: 'case_2', slaDueAt: at(60).toISOString() }, at(2)))
    const open = await service.list(A, ['open', 'acknowledged'], 100)
    expect(open.map((x) => [x.key, x.state, x.raisedAt])).toEqual([
      ['sla_75:case_2', 'open', at(2)],
      ['new_p0:case_1', 'open', at(0)],
    ])
    // Acknowledging does not resolve one that clears by fact; its owner's clear does.
    const p0 = open[1]!
    expect(await service.acknowledge(A, p0.id)).toMatchObject({ state: 'acknowledged', acknowledgedAt: clock.now() })
    await publish(A, notificationCleared('new_p0', 'case_1', 'case.claimed', at(3)))
    expect((await service.list(A, ['resolved'], 100)).map((x) => [x.key, x.resolvedBy, x.resolvedAt])).toEqual([['new_p0:case_1', 'case.claimed', at(3)]])
    // Another app sees none of them.
    expect(await service.list(B, ['open', 'acknowledged', 'resolved'], 100)).toEqual([])
    await expect(service.acknowledge(B, p0.id)).rejects.toThrow('No such notification')
  })

  it('keeps a clear that came before its raise, and ignores types it does not know', async () => {
    await publish(A, notificationCleared('sla_breach', 'case_3', 'case.decided', at(10)))
    await publish(A, notificationRaised('sla_breach', 'case_3', { caseId: 'case_3', slaDueAt: at(0).toISOString() }, at(9)))
    await publish(A, { id: 'evt_unknown', type: currentType('notification.raised'), key: 'later_type:x', data: { key: 'later_type:x', type: 'later_type', values: {}, occurredAt: at(0).toISOString() } satisfies EventData<'notification.raised.v1'> })
    const all = await service.list(A, ['open', 'acknowledged', 'resolved'], 100)
    expect(all.map((x) => x.key)).not.toContain('sla_breach:case_3')
    expect(all.map((x) => x.key)).not.toContain('later_type:x')
  })

  it('holds nothing about accounts', async () => {
    await publish(A, { id: 'evt_erase', type: currentType('subject.erasure_requested'), key: 'ers_1', data: { erasureId: 'ers_1', subjectExternalId: 'u_jane', occurredAt: at(0).toISOString() } })
    const answer = (await bus.log()).find((l) => l.event.type === 'subject.erased.v1')!.event.data as EventData<'subject.erased.v1'>
    expect(answer).toMatchObject({ group: 'notifications.erasure', status: 'nothing_held' })
  })
})
