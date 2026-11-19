import { describe, expect, it } from 'vitest'
import { newKeyringEntry, open, parseKeyring, seal, sealedKeyId } from '../src/index.ts'

const bytes = (fill: number) => () => new Uint8Array(32).fill(fill)
const K1 = newKeyringEntry('k1', bytes(1))
const K2 = newKeyringEntry('k2', bytes(2))

describe('parseKeyring', () => {
  it('takes the first entry as current, separated by commas or whitespace', () => {
    const ring = parseKeyring(` ${K2},\n${K1} `)
    expect(ring.current).toBe('k2')
    expect([...ring.keys.keys()]).toEqual(['k2', 'k1'])
  })

  it('rejects empty, malformed, short and repeated entries without echoing the key', () => {
    expect(() => parseKeyring('')).toThrow(TypeError)
    expect(() => parseKeyring('nocolon')).toThrow(/Key 1/)
    expect(() => parseKeyring(`k1:${Buffer.alloc(16).toString('base64')}`)).toThrow(/32 bytes/)
    expect(() => parseKeyring(`${K1},${K1}`)).toThrow(/used twice/)
    const err = (() => {
      try {
        parseKeyring('k1:not-base64!')
      } catch (e) {
        return (e as Error).message
      }
    })()
    expect(err).not.toContain('not-base64')
  })
})

describe('seal and open', () => {
  const ring = parseKeyring(K1)

  it('round-trips with the same context and names the sealing key', () => {
    const sealed = seal(ring, 'whsec_abc', 'app_1')
    expect(sealed).toMatch(/^v1\.k1\./)
    expect(sealedKeyId(sealed)).toBe('k1')
    expect(open(ring, sealed, 'app_1')).toBe('whsec_abc')
  })

  it('uses a fresh IV, so the same secret seals differently', () => {
    expect(seal(ring, 'same', 'c')).not.toBe(seal(ring, 'same', 'c'))
  })

  it('does not open in another context or after a change', () => {
    const sealed = seal(ring, 'whsec_abc', 'app_1')
    expect(() => open(ring, sealed, 'app_2')).toThrow(/authenticate/)
    const flipped = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect(() => open(ring, flipped, 'app_1')).toThrow()
  })

  it('opens old values after the master key rotates, and fails clearly once the old key is dropped', () => {
    const old = seal(ring, 'whsec_old', 'c')
    const rotated = parseKeyring(`${K2},${K1}`)
    expect(open(rotated, old, 'c')).toBe('whsec_old')
    expect(sealedKeyId(seal(rotated, 'x', 'c'))).toBe('k2')
    expect(() => open(parseKeyring(K2), old, 'c')).toThrow(/k1 .*not in the keyring/)
  })

  it('rejects values that are not sealed', () => {
    expect(() => open(ring, 'whsec_plain', 'c')).toThrow(TypeError)
    expect(() => sealedKeyId('v1.k1')).toThrow(TypeError)
  })
})
