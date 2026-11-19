import { describe, expect, it } from 'vitest'
import { createMemoryBus, currentRequest, runInRequest, stampRequest } from '../src/index.ts'

describe('the request context', () => {
  it('is there inside runInRequest, through awaits, and gone outside', async () => {
    expect(currentRequest()).toBeUndefined()
    await runInRequest({ requestId: 'req_1' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      expect(currentRequest()).toEqual({ requestId: 'req_1' })
    })
    expect(currentRequest()).toBeUndefined()
  })

  it("stamps an event with the request's id and actor, unless it has meta or no request runs", () => {
    const event = { id: 'evt_1', type: 'a', key: 'k', data: null }
    expect(stampRequest(event)).toBe(event)
    runInRequest({ requestId: 'req_1', actor: { type: 'api_key', id: 'key_1' } }, () => {
      expect(stampRequest(event)).toEqual({ ...event, meta: { requestId: 'req_1', actor: { type: 'api_key', id: 'key_1' } } })
      const own = { ...event, meta: { requestId: 'req_other' } }
      expect(stampRequest(own)).toBe(own)
    })
    runInRequest({}, () => expect(stampRequest(event)).toBe(event))
  })

  it('reaches handlers through the memory bus', async () => {
    const bus = createMemoryBus()
    const seen: unknown[] = []
    bus.subscribe('g', '*', (e) => void seen.push(e.meta))
    await runInRequest({ actor: { type: 'operator', id: 'cli' } }, () => bus.publish({ id: 'evt_1', type: 'a', key: 'k', data: null }))
    await bus.publish({ id: 'evt_2', type: 'a', key: 'k', data: null })
    await bus.drain()
    expect(seen).toEqual([{ actor: { type: 'operator', id: 'cli' } }, undefined])
  })
})
