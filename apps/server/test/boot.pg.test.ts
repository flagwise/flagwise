// Booting the services: every service boots alone, from the runtime and options of its own, on a
// database with only its own migrations (and the platform's), and holds to what a booted service
// must: it serves its routes under its name, answers an erasure request when it stores data, and
// subscribes only to catalogued types (the bus refuses others at subscribe). Postgres tests are
// skipped without TEST_DATABASE_URL.
import { readdirSync, statSync } from 'node:fs'
import { classify } from '@flagwise/classify'
import { currentType, EVENT_CATALOG, eventContract, NOTIFICATION_TYPES, type EventData } from '@flagwise/contracts'
import { delivery } from '@flagwise/delivery'
import { flagging } from '@flagwise/flagging'
import { manualClock } from '@flagwise/kernel'
import { createDatabase, createPgBus, createPgScheduler, memoryStorage, migrate, type RunningService, type ServiceRuntime } from '@flagwise/platform'
import { createTestDatabase, testDatabaseUrl } from '@flagwise/platform/testing'
import { describe, expect, it } from 'vitest'
import { SERVICES } from '../src/services.ts'

type Service = (typeof SERVICES)[number]

const NAMES: readonly string[] = SERVICES.map((s) => s.name)

/** privacy runs erasures and keeps the record of each, so it answers none itself. */
const RUNS_ERASURES = 'privacy'

/** Each service's own options, as server.ts gives them, without an LLM, master keys or a network. */
function boot(service: Service, runtime: ServiceRuntime): RunningService {
  const storage = memoryStorage()
  if (service === flagging) return flagging.boot(runtime, { storage })
  if (service === classify) return classify.boot(runtime, { storage, llm: undefined, redact: true })
  if (service === delivery) return delivery.boot(runtime, { secrets: null })
  return (service as { boot(runtime: ServiceRuntime): RunningService }).boot(runtime)
}

describe('the services', () => {
  it('are every package under packages/modules', () => {
    const dir = new URL('../../../packages/modules/', import.meta.url)
    const packages = readdirSync(dir).filter((d) => statSync(new URL(`${d}/`, dir)).isDirectory())
    expect([...NAMES].sort()).toEqual(packages.sort())
  })

  it('own every catalogued event and notification type (or the platform does, or any service)', () => {
    for (const [type, e] of Object.entries(EVENT_CATALOG)) expect([...NAMES, 'platform', 'any'], type).toContain(e.owner)
    for (const [type, t] of Object.entries(NOTIFICATION_TYPES)) expect(NAMES, type).toContain(t.owner)
  })
})

describe.skipIf(!testDatabaseUrl)('every service boots alone', () => {
  it.each(SERVICES.map((s) => [s.name, s] as const))('%s', async (name, service) => {
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

        // Its routes sit under its name, so a gateway routes by the first segment.
        if (running.routes) expect(running.routes.routes.length).toBeGreaterThan(0)
        for (const route of running.routes?.routes ?? []) expect(route.path, route.path).toMatch(new RegExp(`^/${name}(/|$)`))

        // It takes an erasure request on its own tables, and answers it when it stores data.
        await bus.drain()
        const data: EventData<'subject.erasure_requested.v1'> = { erasureId: 'ers_1', subjectExternalId: 'u_jane_doe', occurredAt: clock.now().toISOString() }
        await bus.publish({ id: 'evt_erase', type: currentType('subject.erasure_requested'), key: 'ers_1', data, appRef: { appId: 'app_a', livemode: true } })
        await bus.drain()
        await scheduler.runDue()
        const answers = (await bus.log()).filter((l) => l.event.type === currentType('subject.erased')).map((l) => l.event.data as EventData<'subject.erased.v1'>)
        expect(answers.length).toBe(service.migrations && name !== RUNS_ERASURES ? 1 : 0)
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
