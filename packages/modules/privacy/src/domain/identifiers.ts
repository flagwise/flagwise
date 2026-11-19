// Identifier normalization and hashing. Tenants compute these hashes on their own server and
// never send raw identifiers, so the rules are published and must be exact.
//
// A key is `{ id, secret }`: `id` a positive integer (its version), `secret` at least 32 bytes;
// anything else throws a RangeError. The hash of a normalized value is
// `hm${id}_` + lowercase hex of HMAC-SHA256(secret, `${kind}:${normalized}`).

import { createHmac } from 'node:crypto'

export type IdentifierKind = 'phone' | 'email' | 'device'

export interface HashKey {
  readonly id: number
  readonly secret: Uint8Array
}

export interface HashOptions {
  readonly defaultCountryCode?: string
}

/**
 * Trims and lowercases an email; null unless the result has no whitespace, exactly one `@`, a
 * non-empty part before it, and a domain that contains a `.` and neither starts nor ends with `.`.
 * Dots and `+tags` are kept.
 */
export function normalizeEmail(_raw: string): string | null {
  const email = _raw.trim().toLowerCase()
  if (/\s/.test(email)) return null
  const parts = email.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts as [string, string]
  if (local === '' || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null
  return email
}

/**
 * An E.164 number (`+` and digits), or null.
 *
 * 1. Remove spaces, `-`, `.`, `(` and `)`. What is left must be digits, optionally after one
 *    leading `+`.
 * 2. Leading `+`: the digits after it are the full number. Leading `00`: the digits after it.
 *    Leading `0`: national format, so the full number is `defaultCountryCode` + the digits after the
 *    `0`. Anything else is taken as already including the country code.
 * 3. The full number must have 8 to 15 digits and not start with `0`.
 *
 * `defaultCountryCode` must be 1 to 3 digits not starting with 0, else RangeError.
 */
export function normalizePhone(_raw: string, _defaultCountryCode = '62'): string | null {
  if (!/^[1-9][0-9]{0,2}$/.test(_defaultCountryCode)) throw new RangeError('invalid defaultCountryCode')
  const cleaned = _raw.replace(/[ \-.()]/g, '')
  if (!/^\+?[0-9]+$/.test(cleaned)) return null
  let full: string
  if (cleaned.startsWith('+')) full = cleaned.slice(1)
  else if (cleaned.startsWith('00')) full = cleaned.slice(2)
  else if (cleaned.startsWith('0')) full = _defaultCountryCode + cleaned.slice(1)
  else full = cleaned
  if (full.length < 8 || full.length > 15 || full.startsWith('0')) return null
  return `+${full}`
}

/** Trims a device id; null when empty or longer than 256 characters. Case is kept. */
export function normalizeDeviceId(_raw: string): string | null {
  const id = _raw.trim()
  return id === '' || id.length > 256 ? null : id
}

/** Normalizes `raw` for its kind and hashes it with one key; null when `raw` is not valid. */
export function hashIdentifier(_kind: IdentifierKind, _raw: string, _key: HashKey, _opts?: HashOptions): string | null {
  checkKey(_key)
  const normalized = normalizeFor(_kind, _raw, _opts)
  return normalized === null ? null : digest(_kind, normalized, _key)
}

/** One hash per key, newest version (highest id) first, so signups match hashes stored under older keys. null when `raw` is not valid. */
export function hashAll(
  _kind: IdentifierKind,
  _raw: string,
  _keys: readonly HashKey[],
  _opts?: HashOptions,
): string[] | null {
  for (const key of _keys) checkKey(key)
  const normalized = normalizeFor(_kind, _raw, _opts)
  if (normalized === null) return null
  return [..._keys].sort((a, b) => b.id - a.id).map((key) => digest(_kind, normalized, key))
}

/** `{ keyId, digest }` for `hm<id>_<64 lowercase hex>` (id a positive integer without leading zeros), else null. */
export function parseHash(_hash: string): { keyId: number; digest: string } | null {
  const m = /^hm([1-9][0-9]*)_([0-9a-f]{64})$/.exec(_hash)
  if (!m) return null
  const keyId = Number(m[1])
  if (!Number.isSafeInteger(keyId)) return null
  return { keyId, digest: m[2]! }
}

function checkKey(key: HashKey): void {
  if (!Number.isInteger(key.id) || key.id <= 0) throw new RangeError('key id must be a positive integer')
  if (key.secret.length < 32) throw new RangeError('key secret must be at least 32 bytes')
}

function normalizeFor(kind: IdentifierKind, raw: string, opts?: HashOptions): string | null {
  if (kind === 'email') return normalizeEmail(raw)
  if (kind === 'phone') return normalizePhone(raw, opts?.defaultCountryCode)
  return normalizeDeviceId(raw)
}

function digest(kind: IdentifierKind, normalized: string, key: HashKey): string {
  return `hm${key.id}_${createHmac('sha256', key.secret).update(`${kind}:${normalized}`).digest('hex')}`
}
