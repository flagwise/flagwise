// Hashes computed independently with Python (json + hashlib).
import { describe, expect, it } from 'vitest'
import {
  GENESIS_HASH,
  appendEntry,
  canonicalJson,
  erasePii,
  verifyChain,
  type AuditEntry,
  type AuditInput,
} from '../src/domain/chain.ts'

const bytes = (from: number) => () => Uint8Array.from({ length: 16 }, (_, i) => from + i)

const IN1: AuditInput = {
  at: new Date('2026-11-03T09:00:00.000Z'),
  actor: { type: 'member', id: 'mem_1' },
  action: 'case.decided',
  target: { type: 'case', id: 'case_1' },
  facts: { outcome: 'violation', category_id: 'scams_fraud.romance_scam', action_keys: ['suspend_7d'] },
  pii: { public_reason: 'Asked a match for money transfer.', internal_note: 'Same as last week 😤' },
}
const IN2: AuditInput = {
  at: new Date('2026-11-03T09:00:05.000Z'),
  actor: { type: 'system', id: 'delivery' },
  action: 'action.requested',
  target: { type: 'action_request', id: 'acr_1' },
  facts: { action_key: 'suspend_7d', attempt: 1, ok: true, latency_ms: 120.5, note: null },
}
const IN3: AuditInput = {
  at: new Date('2026-11-03T09:01:00.000Z'),
  actor: { type: 'api_key', id: 'key_1' },
  action: 'action.confirmed',
  target: { type: 'action_request', id: 'acr_1' },
  facts: {},
  pii: { email: 'b@example.com' },
}

const E1: AuditEntry = {
  seq: 1,
  at: '2026-11-03T09:00:00.000Z',
  actor: IN1.actor,
  action: IN1.action,
  target: IN1.target,
  facts: IN1.facts,
  pii: IN1.pii!,
  piiSalt: '000102030405060708090a0b0c0d0e0f',
  piiDigest: 'd802db69ba8823e0220e36ac7bcec01180adfe3bf386383275bede779a02d3b3',
  prevHash: GENESIS_HASH,
  hash: 'a51b43715dcf8acf71137625bc622709aafc7fcfeef4105b1345fa295a897723',
}
const E2: AuditEntry = {
  seq: 2,
  at: '2026-11-03T09:00:05.000Z',
  actor: IN2.actor,
  action: IN2.action,
  target: IN2.target,
  facts: IN2.facts,
  pii: null,
  piiSalt: null,
  piiDigest: null,
  prevHash: E1.hash,
  hash: 'c7b03a278b88c31b215814c866f61cd8bffa02e6aca35f6b75601cdb6a1cfbfb',
}
const E3: AuditEntry = {
  seq: 3,
  at: '2026-11-03T09:01:00.000Z',
  actor: IN3.actor,
  action: IN3.action,
  target: IN3.target,
  facts: {},
  pii: IN3.pii!,
  piiSalt: '101112131415161718191a1b1c1d1e1f',
  piiDigest: '07cd57f99cc41a20bdd70566eee431e26f8b347706a277e060c98f16e59ca1d3',
  prevHash: E2.hash,
  hash: 'cd619c46769a6ce94170b2b2fc1bf9c756cedc68a90ad22b9e9a4e856334ab46',
}

describe('canonicalJson', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalJson({ b: [1, 'x', { z: null, a: true }], a: 'q"\n\u0001é' })).toBe(
      '{"a":"q\\"\\n\\u0001é","b":[1,"x",{"a":true,"z":null}]}',
    )
  })

  it('writes scalars like JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(-0.5)).toBe('-0.5')
    expect(canonicalJson('😤')).toBe('"😤"')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({})).toBe('{}')
  })

  it('leaves out undefined object properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('sorts keys by plain string comparison', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, '10': 5, '9': 6 })).toBe('{"10":5,"9":6,"B":2,"_":4,"a":3,"b":1}')
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['undefined in an array', [1, undefined]],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 10n],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a nested Date', { at: new Date(0) }],
    ['a class instance', new (class Thing {})()],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })
})

describe('appendEntry', () => {
  it('builds the first entry exactly', () => {
    expect(appendEntry(null, IN1, bytes(0))).toEqual(E1)
  })

  it('chains the next entries', () => {
    expect(appendEntry(E1, IN2)).toEqual(E2)
    expect(appendEntry(E2, IN3, bytes(16))).toEqual(E3)
  })

  it('asks for 16 random bytes only when there is personal data', () => {
    const calls: number[] = []
    const rec = (n: number) => (calls.push(n), new Uint8Array(n))
    appendEntry(null, IN2, rec)
    expect(calls).toEqual([])
    appendEntry(null, IN1, rec)
    expect(calls).toEqual([16])
  })

  it('uses a random salt by default', () => {
    const a = appendEntry(null, IN1)
    const b = appendEntry(null, IN1)
    expect(a.piiSalt).toMatch(/^[0-9a-f]{32}$/)
    expect(a.piiSalt).not.toBe(b.piiSalt)
    expect(a.hash).not.toBe(b.hash)
    expect(verifyChain([a])).toEqual({ ok: true })
  })
})

describe('erasePii', () => {
  it('removes personal data and keeps the digest', () => {
    expect(erasePii(E1)).toEqual({ ...E1, pii: null, piiSalt: null })
  })

  it('does not change the original entry', () => {
    erasePii(E1)
    expect(E1.pii).not.toBeNull()
  })

  it('leaves the chain valid', () => {
    expect(verifyChain([erasePii(E1), E2, erasePii(E3)])).toEqual({ ok: true })
  })
})

describe('verifyChain', () => {
  it('accepts a valid chain and an empty one', () => {
    expect(verifyChain([E1, E2, E3])).toEqual({ ok: true })
    expect(verifyChain([])).toEqual({ ok: true })
  })

  it('starts after a checkpoint once old entries are purged', () => {
    expect(verifyChain([E2, E3], { seq: 1, hash: E1.hash })).toEqual({ ok: true })
    expect(verifyChain([E3], { seq: 2, hash: E2.hash })).toEqual({ ok: true })
  })

  it('reports a chain that does not start at 1, or not after the checkpoint', () => {
    expect(verifyChain([E2, E3])).toEqual({ ok: false, seq: 2, reason: 'seq_gap' })
    expect(verifyChain([E3], { seq: 1, hash: E1.hash })).toEqual({ ok: false, seq: 3, reason: 'seq_gap' })
    expect(verifyChain([E2], { seq: 1, hash: E2.hash })).toEqual({ ok: false, seq: 2, reason: 'prev_mismatch' })
  })

  it('reports a missing entry', () => {
    expect(verifyChain([E1, E3])).toEqual({ ok: false, seq: 3, reason: 'seq_gap' })
  })

  it('reports an entry removed and renumbered', () => {
    expect(verifyChain([E1, { ...E3, seq: 2 }])).toEqual({ ok: false, seq: 2, reason: 'prev_mismatch' })
  })

  it('reports edited facts and other covered fields', () => {
    expect(verifyChain([E1, { ...E2, facts: { ...E2.facts, ok: false } }, E3])).toEqual({ ok: false, seq: 2, reason: 'hash_mismatch' })
    expect(verifyChain([{ ...E1, at: '2026-11-03T08:00:00.000Z' }])).toEqual({ ok: false, seq: 1, reason: 'hash_mismatch' })
    expect(verifyChain([{ ...E1, actor: { type: 'member', id: 'mem_2' } }])).toEqual({ ok: false, seq: 1, reason: 'hash_mismatch' })
  })

  it('reports edited personal data', () => {
    expect(verifyChain([{ ...E1, pii: { ...E1.pii!, internal_note: 'nothing to see' } }])).toEqual({
      ok: false,
      seq: 1,
      reason: 'pii_mismatch',
    })
  })

  it('reports a swapped digest, even after erasure', () => {
    expect(verifyChain([{ ...erasePii(E1), piiDigest: E3.piiDigest }])).toEqual({ ok: false, seq: 1, reason: 'hash_mismatch' })
  })

  it('reports half-erased personal data', () => {
    expect(verifyChain([{ ...E1, piiSalt: null }])).toEqual({ ok: false, seq: 1, reason: 'pii_mismatch' })
    expect(verifyChain([{ ...E1, pii: null }])).toEqual({ ok: false, seq: 1, reason: 'pii_mismatch' })
  })

  it('reports a recomputed hash that no longer links', () => {
    const forged = appendEntry(E1, { ...IN2, facts: { ...IN2.facts, ok: false } })
    expect(verifyChain([E1, forged, E3])).toEqual({ ok: false, seq: 3, reason: 'prev_mismatch' })
  })

  it('reports only the first problem', () => {
    expect(verifyChain([{ ...E1, hash: 'f'.repeat(64) }, { ...E2, seq: 9 }])).toEqual({ ok: false, seq: 1, reason: 'hash_mismatch' })
  })
})
