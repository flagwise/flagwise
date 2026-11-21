// Every service boots alone: on a database with only its own migrations (and the platform's), from
// the runtime and options of its own, its handlers take an erasure request without touching another
// service's tables and answer it. Skipped without TEST_DATABASE_URL.
import { classify } from '@flagwise/classify'
import { currentType, eventContract, type EventData } from '@flagwise/contracts'
import { delivery } from '@flagwise/delivery'
import { flagging } from '@flagwise/flagging'
import { manualClock } from '@flagwise/kernel'
import { createDatabase, createPgBus, createPgScheduler, memoryStorage, migrate, type RunningService, type ServiceRuntime } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl } from '@flagwise/platform/testing'
import { describe, expect, it } from 'vitest'
import { SERVICES } from '../src/modules.ts'

type Service = (typeof SERVICES)[number]

/** The group each service answers an erasure request from; privacy runs erasures, and scoring, disputes and analytics keep nothing yet. */
const ERASURE_GROUP: Partial<Record<Service['name'], string>> = {
  apps: 'apps.erasure',
  auth: 'auth.erasure',
  policy: 'policy.erasure',
  flagging: 'intake.erasure',
  classify: 'classify.erasure',
  triage: 'triage.erasure',
  moderation: 'cases.erasure',
  delivery: 'delivery.erasure',
  notifications: 'notifications.erasure',
  audit: 'audit.erasure',
}

/** Each service's own options, as server.ts gives them, without an LLM, master keys or a network. */
function boot(service: Service, runtime: ServiceRuntime): RunningService {
  const storage = memoryStorage()
  if (service === flagging) return flagging.boot(runtime, { storage })
  if (service === classify) return classify.boot(runtime, { storage, llm: undefined, redact: true })
  if (service === delivery) return delivery.boot(runtime, { secrets: null })
  return (service as { boot(runtime: ServiceRuntime): RunningService }).boot(runtime)
}

describe.skipIf(!testDatabaseUrl)('every service boots alone', () => {
  it.each(SERVICES.map((s) => [s.name, s] as const))('%s', async (_name, service) => {
    const t = await createTestDatabase()
    try {
      await migrate(t.ownerUrl, service.migrations ? [service.migrations] : [], t.roles)
      const db = createDatabase({ appUrl: t.appUrl, systemUrl: t.systemUrl })
      const clock = manualClock('2026-11-20T09:00:00Z')
      const errors: unknown[] = []
      const bus = createPgBus(db, { contract: eventContract, retryDelayMs: () => 0, maxAttempts: 1 })
      const scheduler = createPgScheduler(db, { clock, onError: (err) => void errors.push(err) })
      try {
        const running = boot(service, { db, bus, scheduler, clock, onError: (err) => void errors.push(err) })
        await bus.drain()
        const data: EventData<'subject.erasure_requested.v1'> = { erasureId: 'ers_1', subjectExternalId: 'u_jane_doe', occurredAt: clock.now().toISOString() }
        await bus.publish({ id: 'evt_erase', type: currentType('subject.erasure_requested'), key: 'ers_1', data, appRef: { appId: 'app_a', livemode: true } })
        await bus.drain()
        await scheduler.runDue()
        const answers = (await bus.log()).filter((l) => l.event.type === 'subject.erased.v1').map((l) => (l.event.data as EventData<'subject.erased.v1'>).group)
        expect(answers).toEqual(ERASURE_GROUP[service.name] ? [ERASURE_GROUP[service.name]] : [])
        expect(await bus.deadLetters()).toEqual([])
        expect(errors).toEqual([])
        running.start?.()
        await running.stop?.()
      } finally {
        await bus.stop()
        await scheduler.stop()
        await db.close()
      }
    } finally {
      await t.drop()
    }
  })
})
