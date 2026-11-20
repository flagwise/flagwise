// API keys: `fw_live_` or `fw_test_`, then a 40-character base62 body (alphabet `0-9`, `A-Z`, `a-z`).
// Only a SHA-256 of the key is stored; the first 12 characters of the body are kept in clear to find
// it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApiKeyScope } from '@flagwise/kernel'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BODY_LENGTH = 40
const LOOKUP_LENGTH = 12
const KEY_PATTERN = /^fw_(live|test)_([0-9A-Za-z]{40})$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const SCOPE_ORDER: readonly ApiKeyScope[] = ['flagging', 'actions', 'admin']
const MIN_OVERLAP_MS = 3_600_000
const MAX_OVERLAP_MS = 7 * 86_400_000

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export interface GeneratedApiKey {
  readonly key: string
  readonly lookup: string
  readonly hash: string
}

export interface KeyLifetime {
  readonly createdAt: Date
  readonly revokedAt?: Date | undefined
  readonly expiresAt?: Date | undefined
}

/**
 * A new key with its lookup prefix and hash. The body is built without bias: take `random(64)`, and
 * for each byte b in order append `alphabet[b % 62]` when b < 248 (skip it otherwise), stopping at 40
 * characters; ask for another chunk when one runs out. `hash` is the lowercase hex SHA-256 of the
 * whole key.
 */
export function generateApiKey(livemode: boolean, random?: (n: number) => Uint8Array): GeneratedApiKey {
  const bytesSource = random ?? ((n: number) => new Uint8Array(randomBytes(n)))
  let body = ''
  while (body.length < BODY_LENGTH) {
    for (const b of bytesSource(64)) {
      if (b >= 248) continue
      body += ALPHABET[b % 62]
      if (body.length === BODY_LENGTH) break
    }
  }
  const key = `${livemode ? 'fw_live_' : 'fw_test_'}${body}`
  return { key, lookup: body.slice(0, LOOKUP_LENGTH), hash: sha256Hex(key) }
}

/** `{ livemode, lookup }` for a well-formed key, else null. */
export function parseApiKey(key: string): { livemode: boolean; lookup: string } | null {
  const m = KEY_PATTERN.exec(key)
  if (!m) return null
  return { livemode: m[1] === 'live', lookup: m[2]!.slice(0, LOOKUP_LENGTH) }
}

/** True when the key is well-formed and its SHA-256 equals storedHash (64 lowercase hex), compared in constant time. */
export function verifyApiKey(key: string, storedHash: string): boolean {
  if (!KEY_PATTERN.test(key) || !HASH_PATTERN.test(storedHash)) return false
  return timingSafeEqual(Buffer.from(sha256Hex(key), 'hex'), Buffer.from(storedHash, 'hex'))
}

/** The prefix, the lookup and `…`, e.g. `fw_live_ELSZgnu07ELS…`; a malformed key throws a TypeError. */
export function maskApiKey(key: string): string {
  const parsed = parseApiKey(key)
  if (!parsed) throw new TypeError('malformed API key')
  return `${parsed.livemode ? 'fw_live_' : 'fw_test_'}${parsed.lookup}…`
}

/** Scopes deduplicated in the order flagging, actions, admin; null when empty or containing anything else. */
export function normalizeScopes(scopes: readonly string[]): ApiKeyScope[] | null {
  if (scopes.length === 0 || !scopes.every((s) => (SCOPE_ORDER as readonly string[]).includes(s))) return null
  return SCOPE_ORDER.filter((s) => scopes.includes(s))
}

/** When a rotated-out key stops working: rotatedAt + overlap, where the overlap is 1 hour to 7 days inclusive (else RangeError). */
export function rotationExpiry(rotatedAt: Date, overlapMs: number): Date {
  if (!(overlapMs >= MIN_OVERLAP_MS && overlapMs <= MAX_OVERLAP_MS)) throw new RangeError('overlap must be between 1 hour and 7 days')
  return new Date(rotatedAt.getTime() + overlapMs)
}

/** Active from createdAt on, until revokedAt or expiresAt when set. */
export function isKeyActive(key: KeyLifetime, now: Date): boolean {
  const t = now.getTime()
  if (t < key.createdAt.getTime()) return false
  if (key.revokedAt && t >= key.revokedAt.getTime()) return false
  if (key.expiresAt && t >= key.expiresAt.getTime()) return false
  return true
}
