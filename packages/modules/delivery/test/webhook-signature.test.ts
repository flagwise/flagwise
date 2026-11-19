// Vectors computed with Python's hmac module;
// the first one is the example published by the Standard Webhooks spec.
import { manualClock } from '@flagwise/kernel'
import { describe, expect, it } from 'vitest'
import { generateSecret, sign, signatureHeaders, verify } from '../src/domain/webhook-signature.ts'

const SPEC_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const SPEC_MSG = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestampSeconds: 1614265330, body: '{"test": 2432232314}' }
const SPEC_SIG = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='

const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' // bytes 0..31
const T = 1762161164
const MSG = {
  id: 'evt_01HF7YAT00E41861050R3GG28A',
  timestampSeconds: T,
  body: '{"type":"action.requested","data":{"action_key":"suspend_7d"}}',
}
const MSG_SIG = 'v1,czCkNkhyL3OHqNMiyhxtuZEt6rZ+a6eXm+o5zR8GcKc='
const at = (seconds: number) => ({ clock: manualClock(new Date(seconds * 1000)) })

const headersFor = (sig: string, m = MSG) => ({
  'webhook-id': m.id,
  'webhook-timestamp': String(m.timestampSeconds),
  'webhook-signature': sig,
})

describe('sign', () => {
  it('matches the Standard Webhooks example', () => {
    expect(sign(SPEC_SECRET, SPEC_MSG)).toBe(SPEC_SIG)
  })

  it('matches an independently computed signature', () => {
    expect(sign(SECRET, MSG)).toBe(MSG_SIG)
  })

  it('signs the body as UTF-8', () => {
    expect(sign(SECRET, { id: 'evt_x', timestampSeconds: T, body: '{"text":"hey there 😘"}' })).toBe(
      'v1,J6RTif68oI5GVkAgnrUauaNDLaDTWDWgoIKbPPp9vWk=',
    )
  })

  it.each([
    ['no prefix', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
    ['wrong prefix', 'whsk_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
    ['not base64', 'whsec_not*base64!!'],
    ['bad length', 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS'],
    ['too short (16 bytes)', 'whsec_AAECAwQFBgcICQoLDA0ODw=='],
    ['too long (65 bytes)', `whsec_${Buffer.alloc(65).toString('base64')}`],
    ['empty', ''],
  ])('rejects a secret with %s', (_label, secret) => {
    expect(() => sign(secret, MSG)).toThrow(TypeError)
  })

  it('accepts 24 and 64 byte secrets', () => {
    expect(sign(`whsec_${Buffer.alloc(24, 1).toString('base64')}`, MSG)).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/)
    expect(sign(`whsec_${Buffer.alloc(64, 1).toString('base64')}`, MSG)).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/)
  })
})

describe('generateSecret', () => {
  it('encodes 32 random bytes', () => {
    const calls: number[] = []
    const secret = generateSecret((n) => {
      calls.push(n)
      return Uint8Array.from({ length: n }, (_, i) => i)
    })
    expect(secret).toBe(SECRET)
    expect(calls).toEqual([32])
  })

  it('makes usable, different secrets by default', () => {
    const a = generateSecret()
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(a).not.toBe(generateSecret())
    expect(verify(a, signatureHeaders(a, MSG), MSG.body, at(T))).toEqual({ ok: true, id: MSG.id, timestampSeconds: T })
  })
})

describe('signatureHeaders', () => {
  it('builds the three headers', () => {
    expect(signatureHeaders(SECRET, MSG)).toEqual(headersFor(MSG_SIG))
  })

  it('signs with every secret during rotation, in order', () => {
    expect(signatureHeaders([SECRET, SPEC_SECRET], MSG)['webhook-signature']).toBe(
      `${MSG_SIG} ${sign(SPEC_SECRET, MSG)}`,
    )
  })
})

describe('verify', () => {
  it('accepts a valid signature', () => {
    expect(verify(SECRET, headersFor(MSG_SIG), MSG.body, at(T))).toEqual({ ok: true, id: MSG.id, timestampSeconds: T })
  })

  it('accepts the Standard Webhooks example', () => {
    expect(verify(SPEC_SECRET, headersFor(SPEC_SIG, SPEC_MSG), SPEC_MSG.body, at(SPEC_MSG.timestampSeconds)).ok).toBe(true)
  })

  it('matches header names case-insensitively', () => {
    const h = { 'Webhook-Id': MSG.id, 'WEBHOOK-TIMESTAMP': String(T), 'webhook-Signature': MSG_SIG }
    expect(verify(SECRET, h, MSG.body, at(T)).ok).toBe(true)
  })

  it('accepts any matching entry among several, ignoring other versions', () => {
    const sig = `v1a,${MSG_SIG.slice(3)} v1,${'A'.repeat(43)}= ${MSG_SIG}`
    expect(verify(SECRET, headersFor(sig), MSG.body, at(T)).ok).toBe(true)
  })

  it('accepts a signature made with any of the given secrets', () => {
    expect(verify([SPEC_SECRET, SECRET], headersFor(MSG_SIG), MSG.body, at(T)).ok).toBe(true)
  })

  it.each([
    ['webhook-id', { 'webhook-timestamp': String(T), 'webhook-signature': MSG_SIG }],
    ['webhook-timestamp', { 'webhook-id': MSG.id, 'webhook-signature': MSG_SIG }],
    ['webhook-signature', { 'webhook-id': MSG.id, 'webhook-timestamp': String(T) }],
    ['an empty header', { ...headersFor(MSG_SIG), 'webhook-id': '' }],
  ])('reports missing_headers without %s', (_label, h) => {
    expect(verify(SECRET, h, MSG.body, at(T))).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it.each(['abc', '1762161164.5', '-1762161164', '1e9', ' 1762161164'])('reports invalid_timestamp for %j', (ts) => {
    expect(verify(SECRET, { ...headersFor(MSG_SIG), 'webhook-timestamp': ts }, MSG.body, at(T))).toEqual({
      ok: false,
      reason: 'invalid_timestamp',
    })
  })

  it('allows exactly the tolerance in both directions', () => {
    const h = headersFor(MSG_SIG)
    expect(verify(SECRET, h, MSG.body, at(T + 300)).ok).toBe(true)
    expect(verify(SECRET, h, MSG.body, at(T - 300)).ok).toBe(true)
  })

  it('rejects timestamps outside the tolerance', () => {
    const h = headersFor(MSG_SIG)
    expect(verify(SECRET, h, MSG.body, at(T + 301))).toEqual({ ok: false, reason: 'timestamp_too_old' })
    expect(verify(SECRET, h, MSG.body, at(T - 301))).toEqual({ ok: false, reason: 'timestamp_too_new' })
  })

  it('rounds now down to whole seconds', () => {
    const clock = manualClock(new Date((T + 300) * 1000 + 999))
    expect(verify(SECRET, headersFor(MSG_SIG), MSG.body, { clock }).ok).toBe(true)
  })

  it('uses a custom tolerance', () => {
    const h = headersFor(MSG_SIG)
    expect(verify(SECRET, h, MSG.body, { ...at(T + 31), toleranceSeconds: 30 })).toEqual({ ok: false, reason: 'timestamp_too_old' })
    expect(verify(SECRET, h, MSG.body, { ...at(T + 30), toleranceSeconds: 30 }).ok).toBe(true)
  })

  it('checks the timestamp before the signature', () => {
    expect(verify(SECRET, headersFor('v1,bogus'), MSG.body, at(T + 1000))).toEqual({ ok: false, reason: 'timestamp_too_old' })
  })

  it.each([
    ['a changed body', MSG_SIG, `${MSG.body} `, SECRET],
    ['another secret', MSG_SIG, MSG.body, SPEC_SECRET],
    ['a garbage signature', 'v1,bogus', MSG.body, SECRET],
    ['only another version', `v2,${MSG_SIG.slice(3)}`, MSG.body, SECRET],
    ['no version prefix', MSG_SIG.slice(3), MSG.body, SECRET],
  ])('reports invalid_signature for %s', (_label, sig, body, secret) => {
    expect(verify(secret, headersFor(sig), body, at(T))).toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('rejects a signature for another message id or timestamp', () => {
    expect(verify(SECRET, { ...headersFor(MSG_SIG), 'webhook-id': 'evt_other' }, MSG.body, at(T))).toEqual({
      ok: false,
      reason: 'invalid_signature',
    })
    expect(verify(SECRET, { ...headersFor(MSG_SIG), 'webhook-timestamp': String(T + 1) }, MSG.body, at(T))).toEqual({
      ok: false,
      reason: 'invalid_signature',
    })
  })

  it('throws on an invalid secret instead of reporting a bad signature', () => {
    expect(() => verify('nope', headersFor(MSG_SIG), MSG.body, at(T))).toThrow(TypeError)
  })
})
