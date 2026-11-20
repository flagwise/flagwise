// Prefixed IDs such as `case_01HF7YAT00E41861050R3GG28A`: a type prefix, `_`, and a UUIDv7 written
// in Crockford base32.

import { systemClock, type Clock } from './clock.ts'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BODY = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export const ID_PREFIXES = ['app', 'mem', 'key', 'rpt', 'case', 'dec', 'acr', 'apl', 'ers', 'evt', 'whe', 'ntf'] as const
export type IdPrefix = (typeof ID_PREFIXES)[number]
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`

export interface NewIdOptions {
  readonly clock?: Clock
  readonly random?: (n: number) => Uint8Array
}

export interface ParsedId {
  readonly prefix: IdPrefix
  readonly uuid: string
  readonly timestampMs: number
}

/**
 * Makes a new ID: `<prefix>_<26 characters>`.
 *
 * The 26 characters encode a 128-bit UUIDv7 in Crockford base32, the same way ULIDs are written:
 * alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U), uppercase only. The 128 bits are read
 * as one big-endian number, padded on the left with 2 zero bits to 130 bits, then split into 26
 * groups of 5 bits, most significant first, so the first character is always `0` to `7`.
 *
 * UUIDv7 byte layout (16 bytes, big-endian), with `r` = the 10 random bytes:
 *
 *     bytes 0-5   unix time in milliseconds (48 bits)
 *     byte 6      0x70 | (r[0] & 0x0f)      version 7 + 4 random bits
 *     byte 7      r[1]
 *     byte 8      0x80 | (r[2] & 0x3f)      variant 0b10 + 6 random bits
 *     bytes 9-15  r[3] .. r[9]
 *
 * `opts.clock` gives the time (default: systemClock). `opts.random(n)` returns n random bytes and
 * is called exactly once, with n = 10 (default: crypto.getRandomValues). IDs made at later
 * milliseconds sort after earlier ones as plain strings.
 */
export function newId<P extends IdPrefix>(prefix: P, opts?: NewIdOptions): Id<P> {
  const ms = BigInt((opts?.clock ?? systemClock).now().getTime())
  const r = (opts?.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(10)
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  bytes[6] = 0x70 | (r[0]! & 0x0f)
  bytes[7] = r[1]!
  bytes[8] = 0x80 | (r[2]! & 0x3f)
  bytes.set(r.subarray(3, 10), 9)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let body = ''
  for (let i = 25; i >= 0; i--) body += ALPHABET[Number((n >> BigInt(5 * i)) & 31n)]
  return `${prefix}_${body}`
}

/**
 * Reads an ID back into `{ prefix, uuid, timestampMs }`, where `uuid` is the canonical lowercase
 * form `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
 *
 * Returns null when `id` is not a valid ID: unknown prefix, no `_`, a body that is not exactly 26
 * characters, a character outside the alphabet (including lowercase), a first character above `7`,
 * or decoded bits that are not version 7 with variant 0b10.
 */
export function parseId(id: string): ParsedId | null {
  const sep = id.indexOf('_')
  if (sep < 0) return null
  const prefix = id.slice(0, sep)
  const body = id.slice(sep + 1)
  if (!(ID_PREFIXES as readonly string[]).includes(prefix) || !BODY.test(body)) return null
  let n = 0n
  for (const ch of body) n = (n << 5n) | BigInt(ALPHABET.indexOf(ch))
  const hex = n.toString(16).padStart(32, '0')
  if (hex[12] !== '7' || !'89ab'.includes(hex[16]!)) return null
  return {
    prefix: prefix as IdPrefix,
    uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    timestampMs: Number(n >> 80n),
  }
}

/** True when `value` is a valid ID with this prefix. */
export function isId<P extends IdPrefix>(value: string, prefix: P): value is Id<P> {
  return parseId(value)?.prefix === prefix
}
