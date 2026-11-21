import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { currentType, EVENT_CATALOG, EventContractError, eventContract, factOf } from '../src/index.ts'

describe('the event catalog', () => {
  // That each owner is a service (or the platform, or any) is checked where the services boot.
  it('names every type by its fact and major, with a semver of that major, an owner and a meaning', () => {
    for (const [type, s] of Object.entries(EVENT_CATALOG)) {
      expect(type).toBe(`${s.name}.v${s.major}`)
      expect(s.name).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(s.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
      expect(Number(s.version.split('.')[0])).toBe(s.major)
      expect(s.owner.length).toBeGreaterThan(0)
      expect(s.meaning.length).toBeGreaterThan(10)
    }
  })

  it('gives each fact one owner across its majors', () => {
    const owners = new Map<string, string>()
    for (const s of Object.values(EVENT_CATALOG)) {
      expect(owners.get(s.name) ?? s.owner).toBe(s.owner)
      owners.set(s.name, s.owner)
    }
  })

  it('describes only data, so every schema converts to JSON Schema', () => {
    for (const [type, s] of Object.entries(EVENT_CATALOG)) {
      expect(() => z.toJSONSchema(s.schema, { io: 'input' }), type).not.toThrow()
    }
  })

  it('publishes a fact under its newest major', () => {
    expect(currentType('case.triaged')).toBe('case.triaged.v1')
    expect(() => currentType('case.nothing' as never)).toThrow(EventContractError)
  })

  it('splits a type into its fact and major', () => {
    expect(factOf('case.triaged.v12')).toEqual({ name: 'case.triaged', major: 12 })
    expect(factOf('case.triaged')).toBeNull()
    expect(factOf('case.triaged.v0')).toBeNull()
  })
})

describe('eventContract', () => {
  const claimed = { caseId: 'case_1', memberId: 'mem_jane', occurredAt: '2026-11-18T09:30:00.000Z' }

  it('answers the schema version of data that fits', () => {
    expect(eventContract.versionOf('case.claimed.v1', claimed)).toBe('1.0.0')
  })

  it('refuses a type that is not in the catalog, also one without its major', () => {
    expect(() => eventContract.versionOf('case.claimed', claimed)).toThrow(/not in the event catalog/)
    expect(() => eventContract.versionOf('case.claimed.v2', claimed)).toThrow(EventContractError)
  })

  it('refuses data that breaks the schema: a missing field, a wrong type, a field it does not know', () => {
    const { memberId: _, ...missing } = claimed
    expect(() => eventContract.versionOf('case.claimed.v1', missing)).toThrow(/memberId/)
    expect(() => eventContract.versionOf('case.claimed.v1', { ...claimed, occurredAt: 'yesterday' })).toThrow(/occurredAt/)
    expect(() => eventContract.versionOf('case.claimed.v1', { ...claimed, appRef: { appId: 'app_1' } })).toThrow(/appRef/)
  })
})
