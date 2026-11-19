// Vectors computed independently in Python.
import { describe, expect, it } from 'vitest'
import { ID_PREFIXES, isId, manualClock, newId, parseId } from '../src/index.ts'

const bytes1to10 = () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
const at = (iso: string | number) => manualClock(new Date(iso))
const T = 1_700_000_000_000 // 2023-11-14T22:13:20.000Z

describe('newId', () => {
  it('encodes time and random bytes exactly as specified', () => {
    expect(newId('case', { clock: at(T), random: bytes1to10 })).toBe('case_01HF7YAT00E41861050R3GG28A')
    expect(newId('rpt', { clock: at(T + 1), random: bytes1to10 })).toBe('rpt_01HF7YAT01E41861050R3GG28A')
  })

  it('handles the smallest and largest values', () => {
    expect(newId('evt', { clock: at(0), random: () => new Uint8Array(10) })).toBe('evt_0000000000E008000000000000')
    expect(newId('evt', { clock: at(2 ** 48 - 1), random: () => new Uint8Array(10).fill(255) })).toBe(
      'evt_7ZZZZZZZZZFZZVZZZZZZZZZZZZ',
    )
  })

  it('asks for exactly 10 random bytes, once', () => {
    const calls: number[] = []
    newId('app', {
      clock: at(T),
      random: (n) => {
        calls.push(n)
        return new Uint8Array(n)
      },
    })
    expect(calls).toEqual([10])
  })

  it('works with the defaults and has the documented shape', () => {
    for (const prefix of ID_PREFIXES) {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`))
    }
  })

  it('uses the current time by default', () => {
    const before = Date.now()
    const parsed = parseId(newId('case'))
    expect(parsed?.timestampMs).toBeGreaterThanOrEqual(before)
    expect(parsed?.timestampMs).toBeLessThanOrEqual(Date.now())
  })

  it('makes different IDs on each call by default', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('case')))
    expect(ids.size).toBe(1000)
  })

  it('sorts by time as plain strings', () => {
    const times = [T + 5, T, T + 86_400_000, T + 1, 0]
    const ids = times.map((t) => newId('case', { clock: at(t), random: () => new Uint8Array(10).fill(200) }))
    const byTime = [...times].sort((a, b) => a - b).map((t) => ids[times.indexOf(t)])
    expect([...ids].sort()).toEqual(byTime)
  })
})

describe('parseId', () => {
  it('returns prefix, canonical uuid and timestamp', () => {
    expect(parseId('case_01HF7YAT00E41861050R3GG28A')).toEqual({
      prefix: 'case',
      uuid: '018bcfe5-6800-7102-8304-05060708090a',
      timestampMs: T,
    })
    expect(parseId('evt_7ZZZZZZZZZFZZVZZZZZZZZZZZZ')).toEqual({
      prefix: 'evt',
      uuid: 'ffffffff-ffff-7fff-bfff-ffffffffffff',
      timestampMs: 2 ** 48 - 1,
    })
  })

  it('round-trips with newId', () => {
    const id = newId('acr', { clock: at('2026-11-03T09:12:44.123Z') })
    const parsed = parseId(id)
    expect(parsed?.prefix).toBe('acr')
    expect(parsed?.timestampMs).toBe(Date.parse('2026-11-03T09:12:44.123Z'))
    expect(parsed?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it.each([
    ['unknown prefix', 'user_01HF7YAT00E41861050R3GG28A'],
    ['no separator', 'case01HF7YAT00E41861050R3GG28A'],
    ['empty body', 'case_'],
    ['too short', 'case_01HF7YAT00E41861050R3GG28'],
    ['too long', 'case_01HF7YAT00E41861050R3GG28AA'],
    ['lowercase', 'case_01hf7yat00e41861050r3gg28a'],
    ['letter outside the alphabet (I)', 'case_01HF7YAT00E41861050R3GG2IA'],
    ['letter outside the alphabet (U)', 'case_01HF7YAT00E41861050R3GG2UA'],
    ['first character above 7', 'case_81HF7YAT00E41861050R3GG28A'],
    ['not version 7', 'case_01HF7YAT00C41861050R3GG28A'],
    ['wrong variant (0b11)', 'case_01HF7YAT00E41C61050R3GG28A'],
    ['wrong variant (0b01)', 'case_01HF7YAT00E41461050R3GG28A'],
    ['empty string', ''],
  ])('rejects %s', (_label, id) => {
    expect(parseId(id)).toBeNull()
  })
})

describe('isId', () => {
  it('checks validity and prefix', () => {
    const id = newId('case')
    expect(isId(id, 'case')).toBe(true)
    expect(isId(id, 'rpt')).toBe(false)
    expect(isId('case_nope', 'case')).toBe(false)
  })
})
