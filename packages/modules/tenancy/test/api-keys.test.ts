// Key vectors computed in Python.
import { describe, expect, it } from 'vitest'
import {
  generateApiKey,
  isKeyActive,
  maskApiKey,
  normalizeScopes,
  parseApiKey,
  rotationExpiry,
  verifyApiKey,
} from '../src/domain/api-keys.ts'

/** Chunk k holds (200 + 64k + 7j) mod 256 for j = 0..63; byte 249 at j = 7 is skipped. */
function stepping() {
  const calls: number[] = []
  let k = 0
  const random = (n: number) => {
    calls.push(n)
    const chunk = Uint8Array.from({ length: n }, (_, j) => (200 + k * 64 + j * 7) % 256)
    k++
    return chunk
  }
  return { random, calls }
}

const LIVE = {
  key: 'fw_live_ELSZgnu07ELSZgnu18FMTahov29GNUbipw3AHOVc',
  lookup: 'ELSZgnu07ELS',
  hash: '4fd6f172c9a29618c6e2b15a0646eab1a1ce6d05c852a8c4fb1cfc512dcd038d',
}
const TEST = {
  key: 'fw_test_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd',
  lookup: '0123456789AB',
  hash: 'c8a5e27661c139843899ea470a6a1deebc04f34df651352573791bcf4af02600',
}

describe('generateApiKey', () => {
  it('builds key, lookup and hash exactly as specified', () => {
    const { random, calls } = stepping()
    expect(generateApiKey(true, random)).toEqual(LIVE)
    expect(calls).toEqual([64])
  })

  it('skips bytes from 248 up and asks for more chunks when needed', () => {
    const calls: number[] = []
    let k = 0
    const random = (n: number) => {
      calls.push(n)
      return k++ === 0 ? new Uint8Array(n).fill(255) : Uint8Array.from({ length: n }, (_, j) => j)
    }
    expect(generateApiKey(false, random)).toEqual(TEST)
    expect(calls).toEqual([64, 64])
  })

  it('makes well-formed, distinct keys by default', () => {
    const keys = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const { key, lookup, hash } = generateApiKey(i % 2 === 0)
      expect(key).toMatch(/^fw_(live|test)_[0-9A-Za-z]{40}$/)
      expect(lookup).toBe(key.slice(8, 20))
      expect(verifyApiKey(key, hash)).toBe(true)
      keys.add(key)
    }
    expect(keys.size).toBe(200)
  })
})

describe('parseApiKey', () => {
  it('reads mode and lookup', () => {
    expect(parseApiKey(LIVE.key)).toEqual({ livemode: true, lookup: LIVE.lookup })
    expect(parseApiKey(TEST.key)).toEqual({ livemode: false, lookup: TEST.lookup })
  })

  it.each([
    ['another mode', LIVE.key.replace('fw_live_', 'fw_prod_')],
    ['no prefix', LIVE.key.slice(8)],
    ['short body', LIVE.key.slice(0, -1)],
    ['long body', `${LIVE.key}x`],
    ['non-base62 character', `${LIVE.key.slice(0, -1)}-`],
    ['uppercase prefix', LIVE.key.replace('fw_live_', 'FW_LIVE_')],
    ['surrounding whitespace', ` ${LIVE.key}`],
    ['empty', ''],
  ])('rejects %s', (_label, key) => {
    expect(parseApiKey(key)).toBeNull()
  })
})

describe('verifyApiKey', () => {
  it('accepts the key that matches the stored hash', () => {
    expect(verifyApiKey(LIVE.key, LIVE.hash)).toBe(true)
    expect(verifyApiKey(TEST.key, TEST.hash)).toBe(true)
  })

  it('rejects another key, a malformed key or a malformed hash', () => {
    expect(verifyApiKey(TEST.key, LIVE.hash)).toBe(false)
    expect(verifyApiKey(`${LIVE.key} `, LIVE.hash)).toBe(false)
    expect(verifyApiKey(LIVE.key, LIVE.hash.toUpperCase())).toBe(false)
    expect(verifyApiKey(LIVE.key, LIVE.hash.slice(0, 63))).toBe(false)
    expect(verifyApiKey(LIVE.key, `${LIVE.hash.slice(0, 63)}g`)).toBe(false)
    expect(verifyApiKey(LIVE.key, '')).toBe(false)
  })
})

describe('maskApiKey', () => {
  it('shows prefix and lookup only', () => {
    expect(maskApiKey(LIVE.key)).toBe('fw_live_ELSZgnu07ELS…')
    expect(maskApiKey(TEST.key)).toBe('fw_test_0123456789AB…')
  })

  it('refuses malformed keys', () => {
    expect(() => maskApiKey('sk_live_123')).toThrow(TypeError)
  })
})

describe('normalizeScopes', () => {
  it('deduplicates into the canonical order', () => {
    expect(normalizeScopes(['admin', 'flagging', 'admin'])).toEqual(['flagging', 'admin'])
    expect(normalizeScopes(['actions'])).toEqual(['actions'])
    expect(normalizeScopes(['admin', 'actions', 'flagging'])).toEqual(['flagging', 'actions', 'admin'])
  })

  it('rejects empty lists and unknown scopes', () => {
    expect(normalizeScopes([])).toBeNull()
    expect(normalizeScopes(['flagging', 'write'])).toBeNull()
    expect(normalizeScopes(['Admin'])).toBeNull()
  })
})

describe('rotationExpiry', () => {
  const at = new Date('2026-11-03T09:00:00.000Z')
  const H = 3_600_000

  it('keeps the old key for the overlap', () => {
    expect(rotationExpiry(at, H)).toEqual(new Date('2026-11-03T10:00:00.000Z'))
    expect(rotationExpiry(at, 7 * 24 * H)).toEqual(new Date('2026-11-10T09:00:00.000Z'))
  })

  it.each([H - 1, 7 * 24 * H + 1, 0, -H, Number.NaN])('rejects an overlap of %s ms', (ms) => {
    expect(() => rotationExpiry(at, ms)).toThrow(RangeError)
  })
})

describe('isKeyActive', () => {
  const t = (iso: string) => new Date(`2026-11-${iso}:00.000Z`)
  const created = t('03T09:00')

  it('is active from creation on', () => {
    expect(isKeyActive({ createdAt: created }, t('03T08:59'))).toBe(false)
    expect(isKeyActive({ createdAt: created }, created)).toBe(true)
    expect(isKeyActive({ createdAt: created }, t('30T00:00'))).toBe(true)
  })

  it('stops at revocation or expiry, whichever comes first', () => {
    const key = { createdAt: created, revokedAt: t('05T00:00'), expiresAt: t('04T00:00') }
    expect(isKeyActive(key, t('03T23:59'))).toBe(true)
    expect(isKeyActive(key, t('04T00:00'))).toBe(false)
    expect(isKeyActive({ createdAt: created, revokedAt: t('04T00:00') }, t('04T00:00'))).toBe(false)
    expect(isKeyActive({ createdAt: created, revokedAt: undefined }, t('04T00:00'))).toBe(true)
  })
})
