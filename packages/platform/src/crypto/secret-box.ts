// Encrypting secrets at rest (such as webhook signing secrets) with a master key the entrypoint
// passes in: from an env var, a file, a vault or a KMS, whichever it chooses. AES-256-GCM; every
// sealed value names the key that sealed it, so the master key can be rotated: keep the old key in
// the keyring to open old values, and reseal them under the new one.

import { createCipheriv, createDecipheriv, getRandomValues } from 'node:crypto'

/** Master keys by id; `current` seals, every key opens what it sealed. */
export interface Keyring {
  readonly current: string
  readonly keys: ReadonlyMap<string, Uint8Array>
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'

/**
 * Parses `id:base64key` entries separated by commas or whitespace; the first is current. Each id is
 * 1 to 32 of A-Z a-z 0-9 _ -, used once; each key is standard base64 of exactly 32 bytes. Anything
 * else throws a TypeError that names the entry by position, never its key.
 */
export function parseKeyring(text: string): Keyring {
  const entries = text.split(/[\s,]+/).filter(Boolean)
  if (entries.length === 0) throw new TypeError('The keyring is empty: give at least one id:base64key')
  const keys = new Map<string, Uint8Array>()
  entries.forEach((entry, i) => {
    const colon = entry.indexOf(':')
    const id = colon < 0 ? '' : entry.slice(0, colon)
    const encoded = colon < 0 ? '' : entry.slice(colon + 1)
    if (!KEY_ID.test(id)) throw new TypeError(`Key ${i + 1}: expected id:base64key with an id of 1 to 32 letters, digits, _ or -`)
    if (keys.has(id)) throw new TypeError(`Key ${i + 1}: the id ${id} is used twice`)
    const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 === 0 ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
    if (bytes.length !== KEY_BYTES) throw new TypeError(`Key ${i + 1} (${id}): expected base64 of exactly ${KEY_BYTES} bytes`)
    keys.set(id, new Uint8Array(bytes))
  })
  return { current: entries[0]!.slice(0, entries[0]!.indexOf(':')), keys }
}

/** A new keyring entry, `id:base64key`, with 32 random bytes from `random` (default crypto.getRandomValues). */
export function newKeyringEntry(id: string, random: (n: number) => Uint8Array = (n) => getRandomValues(new Uint8Array(n))): string {
  if (!KEY_ID.test(id)) throw new TypeError('The key id must be 1 to 32 letters, digits, _ or -')
  return `${id}:${Buffer.from(random(KEY_BYTES)).toString('base64')}`
}

/**
 * Seals `plaintext` with the current key: `v1.<key id>.<base64 of iv, ciphertext and tag>`.
 * `context` is authenticated but not stored: opening needs the same context, so a sealed value
 * copied to another row (another app, say) does not open. A fresh random IV every time.
 */
export function seal(keyring: Keyring, plaintext: string, context: string): string {
  const key = keyring.keys.get(keyring.current)
  if (!key) throw new TypeError(`The current key ${keyring.current} is not in the keyring`)
  const iv = getRandomValues(new Uint8Array(IV_BYTES))
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${VERSION}.${keyring.current}.${Buffer.concat([iv, body]).toString('base64')}`
}

/** The id of the key that sealed `sealed`; throws a TypeError when it is not a sealed value. */
export function sealedKeyId(sealed: string): string {
  return parts(sealed).keyId
}

/**
 * Opens a value from seal() with the same context. Throws a TypeError when it is not a sealed
 * value or its key is not in the keyring, and an Error when it does not authenticate (another
 * context, a changed value or the wrong key).
 */
export function open(keyring: Keyring, sealed: string, context: string): string {
  const { keyId, payload } = parts(sealed)
  const key = keyring.keys.get(keyId)
  if (!key) throw new TypeError(`The key ${keyId} that sealed this value is not in the keyring`)
  const iv = payload.subarray(0, IV_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('The sealed value does not authenticate: another context, a changed value or the wrong key')
  }
}

function parts(sealed: string): { keyId: string; payload: Buffer } {
  const [version, keyId, encoded, ...rest] = sealed.split('.')
  const payload = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
  if (version !== VERSION || !keyId || !KEY_ID.test(keyId) || rest.length > 0 || payload.length < IV_BYTES + TAG_BYTES) {
    throw new TypeError('Not a sealed value')
  }
  return { keyId, payload }
}
