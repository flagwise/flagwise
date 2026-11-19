import { createHash, randomBytes } from 'node:crypto'

// Append-only, hash-chained audit log per app. The chain survives erasing a person's data and
// purging old entries: personal data sits in `pii`, and the chain only covers a salted digest of it,
// so erasing sets `pii` and `piiSalt` to null and keeps `piiDigest`; verification can start after a
// checkpoint, the `{ seq, hash }` of the last purged entry. sha256 below means the lowercase hex
// SHA-256 of the UTF-8 text.

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export interface Ref {
  readonly type: string
  readonly id: string
}

export interface AuditInput {
  readonly at: Date
  readonly actor: Ref
  readonly action: string
  readonly target: Ref
  /** Non-personal facts: ids, categories, before/after config values. */
  readonly facts: { readonly [key: string]: Json }
  /** Personal data (names, free text, emails); erased with the subject. */
  readonly pii?: { readonly [key: string]: Json }
}

export interface AuditEntry {
  readonly seq: number
  readonly at: string
  readonly actor: Ref
  readonly action: string
  readonly target: Ref
  readonly facts: { readonly [key: string]: Json }
  readonly pii: { readonly [key: string]: Json } | null
  readonly piiSalt: string | null
  readonly piiDigest: string | null
  readonly prevHash: string
  readonly hash: string
}

export type ChainProblem = 'seq_gap' | 'prev_mismatch' | 'pii_mismatch' | 'hash_mismatch'

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly seq: number; readonly reason: ChainProblem }

export const GENESIS_HASH = '0'.repeat(64)

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const entryHash = (prevHash: string, body: unknown) => sha256(`${prevHash}\n${canonicalJson(body)}`)

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new TypeError('not a plain object')
    const obj = value as Record<string, unknown>
    const parts = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    return `{${parts.join(',')}}`
  }
  throw new TypeError(`cannot serialize ${typeof value}`)
}

/**
 * JSON with no whitespace and object keys sorted by plain string comparison (as
 * Array.prototype.sort does). Scalars are written as JSON.stringify writes them, arrays keep their
 * order, and object properties whose value is undefined are left out. Throws a TypeError for
 * anything else: non-finite numbers, undefined at the top level or in an array, functions, symbols,
 * bigints, and objects that are not plain objects or arrays (a Date, a Map, a class instance).
 */
export function canonicalJson(value: unknown): string {
  return canonical(value)
}

/**
 * The next entry after `prev` (or the first, when prev is null): seq + 1 or 1; prevHash = prev.hash
 * or GENESIS_HASH; `at` as an ISO string. With personal data, `piiSalt` = lowercase hex of
 * `random(16)` (called exactly once) and `piiDigest = sha256(piiSalt + "\n" + canonicalJson(pii))`;
 * without it, all three are null and random is not called.
 * `hash = sha256(prevHash + "\n" + canonicalJson({ seq, at, actor, action, target, facts, piiDigest }))`.
 */
export function appendEntry(prev: AuditEntry | null, input: AuditInput, random?: (n: number) => Uint8Array): AuditEntry {
  const seq = prev ? prev.seq + 1 : 1
  const prevHash = prev ? prev.hash : GENESIS_HASH
  const at = input.at.toISOString()
  let pii: AuditEntry['pii'] = null
  let piiSalt: string | null = null
  let piiDigest: string | null = null
  if (input.pii) {
    const bytes = (random ?? ((n: number) => new Uint8Array(randomBytes(n))))(16)
    pii = input.pii
    piiSalt = Buffer.from(bytes).toString('hex')
    piiDigest = sha256(`${piiSalt}\n${canonicalJson(pii)}`)
  }
  const { actor, action, target, facts } = input
  const hash = entryHash(prevHash, { seq, at, actor, action, target, facts, piiDigest })
  return { seq, at, actor, action, target, facts, pii, piiSalt, piiDigest, prevHash, hash }
}

/** A copy with `pii` and `piiSalt` set to null; `piiDigest` and everything else unchanged. */
export function erasePii(entry: AuditEntry): AuditEntry {
  return { ...entry, pii: null, piiSalt: null }
}

/**
 * Checks entries in order and reports the first problem. The first entry must have seq `from.seq +
 * 1` (or 1) and prevHash `from.hash` (or GENESIS_HASH); each later one the previous seq + 1 and
 * hash. Per entry, in this order: 'seq_gap', 'prev_mismatch', 'pii_mismatch' (pii and piiSalt not
 * both null or both set, or the recomputed digest differs), 'hash_mismatch'. The reported seq is the
 * one the broken entry carries. An empty list is ok.
 */
export function verifyChain(entries: readonly AuditEntry[], from?: { readonly seq: number; readonly hash: string }): VerifyResult {
  let seq = from ? from.seq : 0
  let hash = from ? from.hash : GENESIS_HASH
  for (const e of entries) {
    if (e.seq !== seq + 1) return { ok: false, seq: e.seq, reason: 'seq_gap' }
    if (e.prevHash !== hash) return { ok: false, seq: e.seq, reason: 'prev_mismatch' }
    if ((e.pii === null) !== (e.piiSalt === null)) return { ok: false, seq: e.seq, reason: 'pii_mismatch' }
    if (e.pii !== null && e.piiSalt !== null && e.piiDigest !== sha256(`${e.piiSalt}\n${canonicalJson(e.pii)}`)) {
      return { ok: false, seq: e.seq, reason: 'pii_mismatch' }
    }
    const { seq: s, at, actor, action, target, facts, piiDigest } = e
    if (e.hash !== entryHash(e.prevHash, { seq: s, at, actor, action, target, facts, piiDigest })) {
      return { ok: false, seq: e.seq, reason: 'hash_mismatch' }
    }
    seq = e.seq
    hash = e.hash
  }
  return { ok: true }
}
