// Webhook signatures following the Standard Webhooks spec.
//
// Secrets look like `whsec_<base64>`: standard base64 (A-Z a-z 0-9 + /, `=` padding, length a
// multiple of 4) of 24 to 64 key bytes. Any other secret throws a TypeError. The signed content is
// `${id}.${timestampSeconds}.${body}` (UTF-8); a signature is `v1,` + base64(HMAC-SHA256(key bytes,
// signed content)).

import { createHmac, getRandomValues, timingSafeEqual } from 'node:crypto'
import { systemClock, type Clock } from '@flagwise/kernel'

export interface WebhookMessage {
  readonly id: string
  readonly timestampSeconds: number
  readonly body: string
}

export type SignatureHeaders = {
  readonly 'webhook-id': string
  readonly 'webhook-timestamp': string
  readonly 'webhook-signature': string
}

export type VerifyFailure =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'invalid_signature'

export type VerifyResult =
  | { readonly ok: true; readonly id: string; readonly timestampSeconds: number }
  | { readonly ok: false; readonly reason: VerifyFailure }

export interface VerifyOptions {
  readonly clock?: Clock
  readonly toleranceSeconds?: number
}

/** `whsec_` + base64 of 32 bytes from `random(32)` (called once; default crypto.getRandomValues). */
export function generateSecret(random: (n: number) => Uint8Array = randomBytes): string {
  return `${SECRET_PREFIX}${Buffer.from(random(32)).toString('base64')}`
}

/** The `v1,` signature of one message. */
export function sign(secret: string, message: WebhookMessage): string {
  return `v1,${createHmac('sha256', secretKey(secret)).update(`${message.id}.${message.timestampSeconds}.${message.body}`, 'utf8').digest('base64')}`
}

/**
 * The three webhook headers. `webhook-signature` holds one signature per secret, in the order given,
 * joined by a single space; several secrets are used while a secret is being rotated.
 */
export function signatureHeaders(secrets: string | readonly string[], message: WebhookMessage): SignatureHeaders {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  return {
    'webhook-id': message.id,
    'webhook-timestamp': String(message.timestampSeconds),
    'webhook-signature': list.map((secret) => sign(secret, message)).join(' '),
  }
}

/**
 * Checks a delivery and returns the first failure, in this order:
 *
 * 1. 'missing_headers': webhook-id, webhook-timestamp or webhook-signature is missing or empty.
 *    Header names are matched case-insensitively.
 * 2. 'invalid_timestamp': webhook-timestamp is not a string of decimal digits.
 * 3. 'timestamp_too_old' / 'timestamp_too_new': more than `toleranceSeconds` (default 300) before /
 *    after now (`opts.clock`, default systemClock, rounded down to whole seconds). Exactly the
 *    tolerance is accepted.
 * 4. 'invalid_signature': no `v1,` entry (space-separated) equals a signature computed with any of
 *    the secrets. Entries with another version prefix are ignored. Compared in constant time.
 */
export function verify(
  secrets: string | readonly string[],
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
  opts?: VerifyOptions,
): VerifyResult {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  const get = (name: string): string | undefined => {
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
    return undefined
  }
  const id = get('webhook-id')
  const timestamp = get('webhook-timestamp')
  const signature = get('webhook-signature')
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' }
  if (!/^[0-9]+$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' }

  const timestampSeconds = Number(timestamp)
  const tolerance = opts?.toleranceSeconds ?? 300
  const nowSeconds = Math.floor((opts?.clock ?? systemClock).now().getTime() / 1000)
  if (timestampSeconds < nowSeconds - tolerance) return { ok: false, reason: 'timestamp_too_old' }
  if (timestampSeconds > nowSeconds + tolerance) return { ok: false, reason: 'timestamp_too_new' }

  const expected = list.map((secret) => Buffer.from(sign(secret, { id, timestampSeconds, body })))
  const matches = signature
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .some((entry) => {
      const candidate = Buffer.from(entry)
      let found = false
      for (const e of expected) if (e.length === candidate.length && timingSafeEqual(e, candidate)) found = true
      return found
    })
  return matches ? { ok: true, id, timestampSeconds } : { ok: false, reason: 'invalid_signature' }
}

const SECRET_PREFIX = 'whsec_'

function randomBytes(n: number): Uint8Array {
  return getRandomValues(new Uint8Array(n))
}

function secretKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith(SECRET_PREFIX)) throw new TypeError('invalid webhook secret')
  const encoded = secret.slice(SECRET_PREFIX.length)
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new TypeError('invalid webhook secret')
  const key = Buffer.from(encoded, 'base64')
  if (key.length < 24 || key.length > 64) throw new TypeError('invalid webhook secret')
  return key
}
