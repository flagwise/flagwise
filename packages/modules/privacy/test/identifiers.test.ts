// Hash vectors computed with Python's hmac module.
import { describe, expect, it } from 'vitest'
import {
  hashAll,
  hashIdentifier,
  normalizeDeviceId,
  normalizeEmail,
  normalizePhone,
  parseHash,
} from '../src/domain/identifiers.ts'

const K1 = { id: 1, secret: Uint8Array.from({ length: 32 }, (_, i) => i) }
const K2 = { id: 2, secret: Uint8Array.from({ length: 32 }, (_, i) => 32 + i) }

const PHONE_1 = 'hm1_906cd6e5e8b5e46ca88f1ed3078f3e13fc1172ce3cb0de5375ac04d0afc75792'
const PHONE_2 = 'hm2_674fde67f94b4b6a5d292762c37e1358c03e07a1c5a76e1c16f8d971201887e8'
const EMAIL_1 = 'hm1_2e980a0ef2bd908e2d373003f3aa45858f08e142e29306cb522cce76a415f31a'
const EMAIL_2 = 'hm2_e511a78c17737ae788a32f8e9899581b9fcc31b887f46f09cea48a4a23fa5e75'
const DEVICE_1 = 'hm1_4bd1cf3fb4ee3fa4ebb09c31942a6c877966a04cb4ebf06cc428aa6dad2b2f30'
const TAGGED_1 = 'hm1_7d84607edc28c4135ac1682bc94bcf4d6de2013e4688383445303b030c19050a'

describe('normalizeEmail', () => {
  it.each([
    ['jane@example.com', 'jane@example.com'],
    ['  Jane@Example.COM \n', 'jane@example.com'],
    ['Jane.Doe+FW@Gmail.com', 'jane.doe+fw@gmail.com'],
    ['a@b.co', 'a@b.co'],
    ['user@mail.example.co.id', 'user@mail.example.co.id'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected)
  })

  it.each([
    ['empty', ''],
    ['no @', 'jane.example.com'],
    ['two @', 'jane@ex@ample.com'],
    ['nothing before @', '@example.com'],
    ['nothing after @', 'jane@'],
    ['no dot in domain', 'jane@localhost'],
    ['domain starts with a dot', 'jane@.example.com'],
    ['domain ends with a dot', 'jane@example.com.'],
    ['inner whitespace', 'jane doe@example.com'],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeEmail(raw)).toBeNull()
  })
})

describe('normalizePhone', () => {
  it.each([
    ['+6281234567890', '+6281234567890'],
    ['081234567890', '+6281234567890'],
    ['0812-3456-7890', '+6281234567890'],
    ['0812 3456 7890', '+6281234567890'],
    ['(0812) 3456.7890', '+6281234567890'],
    ['+62 812-3456-7890', '+6281234567890'],
    ['006281234567890', '+6281234567890'],
    ['6281234567890', '+6281234567890'],
    ['+1 (415) 555-0132', '+14155550132'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected)
  })

  it('uses the given default country code for national numbers', () => {
    expect(normalizePhone('020 7946 0958', '44')).toBe('+442079460958')
    expect(normalizePhone('+6281234567890', '44')).toBe('+6281234567890')
  })

  it.each([
    ['empty', ''],
    ['letters', '0812-ABC-7890'],
    ['plus in the middle', '0812+34567890'],
    ['two pluses', '++6281234567890'],
    ['other symbols', '0812/3456/7890'],
    ['too short', '+6281234'],
    ['too long (16 digits)', '+6281234567890123'],
    ['starts with 0 after +', '+0812345678'],
    ['only separators', ' - . ( ) '],
  ])('rejects %s', (_label, raw) => {
    expect(normalizePhone(raw)).toBeNull()
  })

  it('accepts 8 and 15 digits', () => {
    expect(normalizePhone('+12345678')).toBe('+12345678')
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345')
  })

  it.each(['', '0', '1234', 'ab', '062'])('rejects default country code %j', (cc) => {
    expect(() => normalizePhone('081234567890', cc)).toThrow(RangeError)
  })
})

describe('normalizeDeviceId', () => {
  it('trims and keeps case', () => {
    expect(normalizeDeviceId('  A1B2-c3d4 ')).toBe('A1B2-c3d4')
  })

  it('rejects empty and oversized ids', () => {
    expect(normalizeDeviceId('   ')).toBeNull()
    expect(normalizeDeviceId('x'.repeat(257))).toBeNull()
    expect(normalizeDeviceId('x'.repeat(256))).toBe('x'.repeat(256))
  })
})

describe('hashIdentifier', () => {
  it('matches independently computed hashes', () => {
    expect(hashIdentifier('phone', '+6281234567890', K1)).toBe(PHONE_1)
    expect(hashIdentifier('email', 'jane@example.com', K1)).toBe(EMAIL_1)
    expect(hashIdentifier('device', 'A1B2-C3D4', K1)).toBe(DEVICE_1)
    expect(hashIdentifier('phone', '+6281234567890', K2)).toBe(PHONE_2)
  })

  it('normalizes before hashing, so equivalent inputs hash the same', () => {
    expect(hashIdentifier('phone', '0812-3456-7890', K1)).toBe(PHONE_1)
    expect(hashIdentifier('email', ' JANE@example.com', K1)).toBe(EMAIL_1)
    expect(hashIdentifier('email', 'Jane.Doe+FW@Gmail.com', K1)).toBe(TAGGED_1)
    expect(hashIdentifier('device', ' A1B2-C3D4\t', K1)).toBe(DEVICE_1)
  })

  it('passes the default country code through', () => {
    expect(hashIdentifier('phone', '81234567890', K1)).not.toBe(PHONE_1)
    expect(hashIdentifier('phone', '081234567890', K1, { defaultCountryCode: '62' })).toBe(PHONE_1)
  })

  it('separates kinds, so the same text hashes differently per kind', () => {
    expect(hashIdentifier('device', 'jane@example.com', K1)).not.toBe(EMAIL_1)
  })

  it('returns null for invalid input', () => {
    expect(hashIdentifier('email', 'not-an-email', K1)).toBeNull()
    expect(hashIdentifier('phone', 'call me', K1)).toBeNull()
    expect(hashIdentifier('device', '  ', K1)).toBeNull()
  })

  it.each([
    ['id 0', { id: 0, secret: K1.secret }],
    ['negative id', { id: -1, secret: K1.secret }],
    ['fractional id', { id: 1.5, secret: K1.secret }],
    ['short secret', { id: 1, secret: new Uint8Array(31) }],
  ])('rejects a key with %s', (_label, key) => {
    expect(() => hashIdentifier('email', 'jane@example.com', key)).toThrow(RangeError)
  })
})

describe('hashAll', () => {
  it('returns one hash per key, newest version first', () => {
    expect(hashAll('email', 'jane@example.com', [K1, K2])).toEqual([EMAIL_2, EMAIL_1])
    expect(hashAll('phone', '081234567890', [K2, K1])).toEqual([PHONE_2, PHONE_1])
  })

  it('handles no keys and invalid input', () => {
    expect(hashAll('email', 'jane@example.com', [])).toEqual([])
    expect(hashAll('email', 'nope', [K1])).toBeNull()
  })
})

describe('parseHash', () => {
  it('splits version and digest', () => {
    expect(parseHash(PHONE_1)).toEqual({ keyId: 1, digest: PHONE_1.slice(4) })
    expect(parseHash(`hm12_${'a'.repeat(64)}`)).toEqual({ keyId: 12, digest: 'a'.repeat(64) })
  })

  it.each([
    ['no version', `hm_${'a'.repeat(64)}`],
    ['version 0', `hm0_${'a'.repeat(64)}`],
    ['leading zero', `hm01_${'a'.repeat(64)}`],
    ['uppercase hex', `hm1_${'A'.repeat(64)}`],
    ['short digest', `hm1_${'a'.repeat(63)}`],
    ['long digest', `hm1_${'a'.repeat(65)}`],
    ['wrong prefix', `hx1_${'a'.repeat(64)}`],
    ['empty', ''],
  ])('rejects %s', (_label, h) => {
    expect(parseHash(h)).toBeNull()
  })
})
