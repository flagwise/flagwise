import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryBus, type BusEvent, type MemoryBus } from '../src/bus/memory-bus.ts'

let n = 0
const ev = (type: string, key: string, data: unknown = null, id = `evt_${++n}`): BusEvent => ({ id, type, key, data })

/** Records every call as `group:eventId#attempt`. */
function recorder() {
  const calls: string[] = []
  const handler = (fail: (e: BusEvent, attempt: number) => boolean = () => false) => (e: BusEvent, ctx: { group: string; attempt: number }) => {
    calls.push(`${ctx.group}:${e.id}#${ctx.attempt}`)
    if (fail(e, ctx.attempt)) throw new Error(`boom ${e.id}`)
  }
  return { calls, handler }
}

let bus: MemoryBus
beforeEach(() => {
  n = 0
  bus = createMemoryBus()
})

describe('publish and subscribe', () => {
  it('delivers matching events to each group once, only on drain', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('cases', ['report.received'], handler())
    bus.subscribe('audit', '*', handler())
    expect(await bus.publish([ev('report.received', 'u_1'), ev('case.opened', 'case_1')])).toBe(2)
    expect(calls).toEqual([])
    expect(bus.pending()).toBe(3)
    expect(await bus.drain()).toBe(3)
    expect([...calls].sort()).toEqual(['audit:evt_1#1', 'audit:evt_2#1', 'cases:evt_1#1'])
    expect(bus.pending()).toBe(0)
  })

  it('logs events with sequence numbers', async () => {
    await bus.publish(ev('a', 'k'))
    await bus.publish([ev('b', 'k'), ev('c', 'j')])
    expect(bus.log().map((l) => [l.seq, l.event.id])).toEqual([
      [1, 'evt_1'],
      [2, 'evt_2'],
      [3, 'evt_3'],
    ])
  })

  it('ignores an event id that was already published', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler())
    const e = ev('a', 'k')
    expect(await bus.publish(e)).toBe(1)
    expect(await bus.publish([e, { ...e, data: 'changed' }, ev('b', 'k')])).toBe(1)
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_2#1'])
    expect(bus.log()).toHaveLength(2)
    expect(bus.log()[0]?.event.data).toBeNull()
  })

  it.each([
    ['empty id', { id: '', type: 'a', key: 'k', data: null }],
    ['empty type', { id: 'x', type: '', key: 'k', data: null }],
    ['empty key', { id: 'x', type: 'a', key: '', data: null }],
    ['non-string key', { id: 'x', type: 'a', key: 5, data: null }],
  ])('rejects an event with %s and publishes nothing', async (_label, bad) => {
    await expect(bus.publish([ev('a', 'k'), bad as BusEvent])).rejects.toThrow(TypeError)
    expect(bus.log()).toEqual([])
  })

  it('does not deliver past events to a new group', async () => {
    await bus.publish(ev('a', 'k'))
    const { calls, handler } = recorder()
    bus.subscribe('late', '*', handler())
    await bus.drain()
    expect(calls).toEqual([])
  })

  it('refuses a group name twice, and bad types', () => {
    bus.subscribe('g', '*', () => {})
    expect(() => bus.subscribe('g', ['a'], () => {})).toThrow(Error)
    expect(() => bus.subscribe('h', [], () => {})).toThrow()
  })

  it('passes the group, sequence number and attempt', async () => {
    const seen: unknown[] = []
    bus.subscribe('g', '*', (e, ctx) => void seen.push([e.id, ctx]))
    await bus.publish([ev('a', 'k'), ev('a', 'k')])
    await bus.drain()
    expect(seen).toEqual([
      ['evt_1', { group: 'g', seq: 1, attempt: 1 }],
      ['evt_2', { group: 'g', seq: 2, attempt: 1 }],
    ])
  })

  it('stops delivering after unsubscribe and drops queued work', async () => {
    const { calls, handler } = recorder()
    const off = bus.subscribe('g', '*', handler())
    await bus.publish(ev('a', 'k'))
    off()
    expect(bus.pending()).toBe(0)
    await bus.publish(ev('b', 'k'))
    expect(await bus.drain()).toBe(0)
    expect(calls).toEqual([])
    expect(() => bus.subscribe('g', '*', handler())).not.toThrow()
  })
})

describe('ordering and retries', () => {
  it('keeps order per key and lets other keys go ahead of a failing one', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler((e, attempt) => e.id === 'evt_1' && attempt < 3))
    await bus.publish([ev('a', 'case_1'), ev('a', 'case_1'), ev('a', 'case_2'), ev('a', 'case_2')])
    expect(await bus.drain()).toBe(6)
    const perKey = (ids: string[]) => calls.filter((c) => ids.some((id) => c.includes(`:${id}#`)))
    expect(perKey(['evt_1', 'evt_2'])).toEqual(['g:evt_1#1', 'g:evt_1#2', 'g:evt_1#3', 'g:evt_2#1'])
    expect(perKey(['evt_3', 'evt_4'])).toEqual(['g:evt_3#1', 'g:evt_4#1'])
    expect(calls.indexOf('g:evt_4#1')).toBeLessThan(calls.indexOf('g:evt_1#3'))
  })

  it('works in rounds: each key head once per round, groups in subscription order', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('first', '*', handler())
    bus.subscribe('second', '*', handler())
    await bus.publish([ev('a', 'k2'), ev('a', 'k1'), ev('a', 'k2')])
    await bus.drain()
    expect(calls).toEqual([
      'first:evt_1#1',
      'first:evt_2#1',
      'second:evt_1#1',
      'second:evt_2#1',
      'first:evt_3#1',
      'second:evt_3#1',
    ])
  })

  it('isolates groups: one group failing does not hold back another', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('flaky', '*', handler(() => true), { maxAttempts: 2 })
    bus.subscribe('steady', '*', handler())
    await bus.publish([ev('a', 'k'), ev('a', 'k')])
    await bus.drain()
    expect(calls.filter((c) => c.startsWith('steady'))).toEqual(['steady:evt_1#1', 'steady:evt_2#1'])
    expect(calls.filter((c) => c.startsWith('flaky'))).toEqual(['flaky:evt_1#1', 'flaky:evt_1#2', 'flaky:evt_2#1', 'flaky:evt_2#2'])
  })

  it('treats a rejected promise as a failure', async () => {
    let tries = 0
    bus.subscribe('g', '*', async () => {
      tries++
      if (tries === 1) throw new Error('later')
    })
    await bus.publish(ev('a', 'k'))
    expect(await bus.drain()).toBe(2)
    expect(bus.deadLetters()).toEqual([])
  })

  it('delivers events published by a handler in the same drain', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('cases', ['report.received'], async (e) => {
      // Guarded so that a bus delivering the wrong types fails this test instead of looping forever.
      if (e.type === 'report.received') await bus.publish(ev('case.opened', 'case_1', null, `opened_for_${e.id}`))
    })
    bus.subscribe('alerts', ['case.opened'], handler())
    await bus.publish(ev('report.received', 'u_1'))
    expect(await bus.drain()).toBe(2)
    expect(calls).toEqual(['alerts:opened_for_evt_1#1'])
  })
})

describe('dead letters', () => {
  it('dead-letters after maxAttempts and unblocks the key', async () => {
    const { calls, handler } = recorder()
    bus = createMemoryBus({ maxAttempts: 3 })
    bus.subscribe('g', '*', handler((e) => e.id === 'evt_1'))
    await bus.publish([ev('a', 'k', { n: 1 }), ev('a', 'k')])
    expect(await bus.drain()).toBe(4)
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_1#2', 'g:evt_1#3', 'g:evt_2#1'])
    expect(bus.deadLetters()).toEqual([{ group: 'g', seq: 1, event: ev('a', 'k', { n: 1 }, 'evt_1'), attempts: 3, error: 'boom evt_1' }])
  })

  it('uses 5 attempts by default and a per-group override', async () => {
    const counts: Record<string, number> = { a: 0, b: 0 }
    bus.subscribe('a', '*', () => {
      counts.a!++
      throw new Error('x')
    })
    bus.subscribe('b', '*', () => {
      counts.b!++
      throw new Error('x')
    }, { maxAttempts: 1 })
    await bus.publish(ev('t', 'k'))
    await bus.drain()
    expect(counts).toEqual({ a: 5, b: 1 })
    expect(bus.deadLetters().map((d) => [d.group, d.attempts])).toEqual([
      ['b', 1],
      ['a', 5],
    ])
  })

  it('records what was thrown when it is not an Error', async () => {
    bus.subscribe('g', '*', () => {
      throw 'plain string'
    }, { maxAttempts: 1 })
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    expect(bus.deadLetters()[0]?.error).toBe('plain string')
  })

  it('retries a dead letter from attempt 1, behind queued work for its key', async () => {
    let broken = true
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler((e) => broken && e.id === 'evt_1'), { maxAttempts: 1 })
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    broken = false
    await bus.publish(ev('a', 'k'))
    expect(bus.retryDeadLetter('g', 'evt_1')).toBe(true)
    expect(bus.deadLetters()).toEqual([])
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_2#1', 'g:evt_1#1'])
    expect(bus.retryDeadLetter('g', 'evt_1')).toBe(false)
  })

  it('keeps dead letters after unsubscribe but cannot retry them', async () => {
    const off = bus.subscribe('g', '*', () => {
      throw new Error('x')
    }, { maxAttempts: 1 })
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    off()
    expect(bus.deadLetters()).toHaveLength(1)
    expect(bus.retryDeadLetter('g', 'evt_1')).toBe(false)
  })

  it.each([0, -1, 1.5])('rejects maxAttempts %s', (maxAttempts) => {
    expect(() => createMemoryBus({ maxAttempts })).toThrow(RangeError)
    expect(() => bus.subscribe('g', '*', () => {}, { maxAttempts })).toThrow(RangeError)
  })
})

describe('replay', () => {
  it('re-delivers logged events of the group types, from a sequence number', async () => {
    await bus.publish([ev('case.opened', 'c1'), ev('report.received', 'u1'), ev('case.opened', 'c2'), ev('case.opened', 'c1')])
    const { calls, handler } = recorder()
    bus.subscribe('projection', ['case.opened'], handler())
    expect(bus.replay('projection')).toBe(3)
    await bus.drain()
    expect([...calls].sort()).toEqual(['projection:evt_1#1', 'projection:evt_3#1', 'projection:evt_4#1'])
    expect(calls.indexOf('projection:evt_1#1')).toBeLessThan(calls.indexOf('projection:evt_4#1'))
    calls.length = 0
    expect(bus.replay('projection', 3)).toBe(2)
    await bus.drain()
    expect([...calls].sort()).toEqual(['projection:evt_3#1', 'projection:evt_4#1'])
  })

  it('delivers again what a group already handled (at least once)', async () => {
    const { calls, handler } = recorder()
    bus.subscribe('g', '*', handler())
    await bus.publish(ev('a', 'k'))
    await bus.drain()
    bus.replay('g')
    await bus.drain()
    expect(calls).toEqual(['g:evt_1#1', 'g:evt_1#1'])
  })

  it('refuses an unknown group', () => {
    expect(() => bus.replay('nobody')).toThrow(Error)
  })
})

describe('pending', () => {
  it('counts per group', async () => {
    bus.subscribe('a', '*', () => {})
    bus.subscribe('b', ['x'], () => {})
    await bus.publish([ev('x', 'k'), ev('y', 'k')])
    expect([bus.pending('a'), bus.pending('b'), bus.pending()]).toEqual([2, 1, 3])
    expect(bus.pending('nobody')).toBe(0)
  })
})

describe('with a contract', () => {
  const contract = {
    versionOf(type: string, data: unknown) {
      if (type !== 'order.placed.v1') throw new TypeError(`${type} is not in the contract`)
      if (typeof (data as { orderId?: unknown } | null)?.orderId !== 'string') throw new TypeError('order.placed.v1 needs an orderId')
      return '1.2.0'
    },
  }

  it('gives each event its schema version and publishes nothing of a call when one breaks it', async () => {
    const checked = createMemoryBus({ contract })
    const seen: BusEvent[] = []
    checked.subscribe('g', '*', (e) => void seen.push(e))
    await expect(checked.publish([ev('order.placed.v1', 'o1', { orderId: 'o1' }), ev('order.placed.v1', 'o2', {})])).rejects.toThrow(/needs an orderId/)
    await expect(checked.publish(ev('order.placed', 'o3', { orderId: 'o3' }))).rejects.toThrow(/not in the contract/)
    expect(checked.log()).toEqual([])
    await checked.publish(ev('order.placed.v1', 'o1', { orderId: 'o1' }))
    await checked.drain()
    expect(seen.map((e) => e.schemaVersion)).toEqual(['1.2.0'])
  })
})
