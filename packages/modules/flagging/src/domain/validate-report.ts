// Validating a submitted report.

import type { FieldError } from '@flagwise/kernel'

export interface Party {
  readonly externalId: string
  readonly accountCreatedAt?: Date
  readonly email?: string
  readonly locale?: 'en' | 'id'
}

export interface ContentItem {
  readonly text: string
  readonly author?: string
  readonly at?: Date
}

export interface ReportInput {
  readonly reporter: Party
  readonly reported: Party
  readonly category: string
  readonly text?: string
  readonly evidence: {
    readonly kind: string
    readonly content: readonly ContentItem[]
    readonly media: readonly string[]
    readonly authorId?: string
    readonly metadata: Readonly<Record<string, string | number | boolean>>
  }
  readonly identifiers: {
    readonly phoneHash?: string
    readonly emailHash?: string
    readonly deviceHash?: string
  }
}

export type ValidationResult =
  | { readonly ok: true; readonly value: ReportInput }
  | { readonly ok: false; readonly status: 413 | 422; readonly errors: readonly FieldError[] }

export const MAX_REPORT_BYTES = 65_536

/**
 * Checks the parsed JSON body of a submitted report; `byteLength` is the raw request body size.
 *
 * Size first: `byteLength > 65_536` returns status 413 with the single error `{ path: '', message:
 * 'Payload exceeds 64 KB' }` and nothing else is checked.
 *
 * Otherwise every field is checked and all errors are returned (status 422), at most one per field:
 * the first rule it breaks, in the order Required, type, Must not be empty, Too long / Too many
 * items, format. Paths use dots and [index] (`reporter.external_id`, `evidence.content[3].text`,
 * `evidence.metadata.conversation_id`); '' is the root. A body that is not an object gives
 * `[{ path: '', message: 'Must be an object' }]`. A field set to null counts as missing; a null
 * array item or metadata value is invalid. "Object" means non-null and not an array. Unknown fields
 * are ignored.
 *
 * Messages: 'Required', 'Must be an object', 'Must be a string', 'Must be an array',
 * 'Must not be empty', 'Too long', 'Too many items', 'Must be an RFC 3339 timestamp',
 * 'Must be en or id', 'Must be a valid email' (no whitespace, exactly one @, something on both
 * sides), 'Must be an identifier hash' (`hm<positive integer, no leading zero>_<64 lowercase hex>`),
 * 'Must be a string or an object', 'Must be an https URL or a sha256 hash' (`https://...` up to
 * 2048 characters, or `sha256:` + 64 lowercase hex), 'Must be a string, number or boolean'.
 *
 * Fields:
 *
 *     reporter, reported   required object: external_id (required string, 1-128),
 *                          account_created_at (optional timestamp), email (optional string, max
 *                          254, valid email), locale (optional, 'en' or 'id')
 *     category             required string, 1-64
 *     text                 optional string, max 5000
 *     evidence             required object: kind (required string, 1-64); content (required array,
 *                          max 50; each a string, or an object with text (required string, may be
 *                          empty), author (optional string, 1-128) and at (optional timestamp));
 *                          media (optional array, max 20, each a media string); author_id (optional
 *                          string, 1-128); metadata (optional object, max 50 keys, values string,
 *                          number or boolean)
 *     identifiers          optional object with optional phone_hash, email_hash, device_hash
 *
 * Timestamps: `YYYY-MM-DDTHH:MM:SS`, optional `.` and 1-9 fraction digits, then `Z` or `+HH:MM` /
 * `-HH:MM` (uppercase T and Z). The date must exist (leap years count), hours 00-23, minutes and
 * seconds 00-59, offset hours 00-23 and minutes 00-59.
 *
 * On success the value is camelCase; timestamps become Dates; each content item becomes `{ text,
 * author?, at? }` (a string item becomes `{ text }`); media defaults to [] and metadata to {};
 * missing optional fields are left out.
 */
export function validateReport(body: unknown, byteLength: number): ValidationResult {
  if (byteLength > MAX_REPORT_BYTES) {
    return { ok: false, status: 413, errors: [{ path: '', message: 'Payload exceeds 64 KB' }] }
  }
  if (!isObject(body)) return { ok: false, status: 422, errors: [{ path: '', message: 'Must be an object' }] }

  const errors: FieldError[] = []
  const fail = (path: string, message: string) => void errors.push({ path, message })

  const reporter = party(body, 'reporter', fail)
  const reported = party(body, 'reported', fail)
  const category = str(body, 'category', 'category', fail, { required: true, min: 1, max: 64 })
  const text = str(body, 'text', 'text', fail, { max: 5000 })
  const evidence = evidenceOf(body, fail)
  const identifiers = identifiersOf(body, fail)

  if (errors.length > 0 || !reporter || !reported || category === undefined || !evidence || !identifiers) {
    return { ok: false, status: 422, errors }
  }
  return {
    ok: true,
    value: { reporter, reported, category, ...(text !== undefined ? { text } : {}), evidence, identifiers },
  }
}

type Fail = (path: string, message: string) => void
type Obj = Record<string, unknown>

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isMissing = (v: unknown) => v === undefined || v === null
const join = (path: string, key: string) => (path === '' ? key : `${path}.${key}`)

/** Reads an optional (or required) string field; undefined when missing or invalid. */
function str(
  obj: Obj,
  key: string,
  path: string,
  fail: Fail,
  rules: { required?: boolean; min?: number; max?: number },
): string | undefined {
  const v = obj[key]
  if (isMissing(v)) {
    if (rules.required) fail(path, 'Required')
    return undefined
  }
  if (typeof v !== 'string') return void fail(path, 'Must be a string')
  if (rules.min !== undefined && v.length < rules.min) return void fail(path, 'Must not be empty')
  if (rules.max !== undefined && v.length > rules.max) return void fail(path, 'Too long')
  return v
}

/** Reads an optional (or required) object field; undefined when missing or invalid. */
function objectField(obj: Obj, key: string, path: string, fail: Fail, required: boolean): Obj | undefined {
  const v = obj[key]
  if (isMissing(v)) {
    if (required) fail(path, 'Required')
    return undefined
  }
  if (!isObject(v)) return void fail(path, 'Must be an object')
  return v
}

/** Reads an optional (or required) array field with an item limit; undefined when missing or invalid. */
function arrayField(obj: Obj, key: string, path: string, fail: Fail, required: boolean, maxItems: number): unknown[] | undefined {
  const v = obj[key]
  if (isMissing(v)) {
    if (required) fail(path, 'Required')
    return undefined
  }
  if (!Array.isArray(v)) return void fail(path, 'Must be an array')
  if (v.length > maxItems) return void fail(path, 'Too many items')
  return v
}

function timestamp(obj: Obj, key: string, path: string, fail: Fail): Date | undefined {
  const raw = str(obj, key, path, fail, {})
  if (raw === undefined) return undefined
  const date = parseTimestamp(raw)
  if (!date) return void fail(path, 'Must be an RFC 3339 timestamp')
  return date
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/

function parseTimestamp(raw: string): Date | null {
  const m = TIMESTAMP.exec(raw)
  if (!m) return null
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth!) return null
  if (hour > 23 || minute > 59 || second > 59) return null

  let offsetMinutes = 0
  if (m[8] !== undefined) {
    const offHour = Number(m[9])
    const offMinute = Number(m[10])
    if (offHour > 23 || offMinute > 59) return null
    offsetMinutes = (m[8] === '-' ? -1 : 1) * (offHour * 60 + offMinute)
  }
  const millis = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3))

  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millis)
  return new Date(date.getTime() - offsetMinutes * 60_000)
}

function isValidEmail(v: string): boolean {
  if (/\s/.test(v)) return false
  const parts = v.split('@')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

function party(body: Obj, key: 'reporter' | 'reported', fail: Fail): Party | undefined {
  const obj = objectField(body, key, key, fail, true)
  if (!obj) return undefined
  const at = (field: string) => join(key, field)

  const externalId = str(obj, 'external_id', at('external_id'), fail, { required: true, min: 1, max: 128 })
  const accountCreatedAt = timestamp(obj, 'account_created_at', at('account_created_at'), fail)
  const email = str(obj, 'email', at('email'), fail, { max: 254 })
  if (email !== undefined && !isValidEmail(email)) fail(at('email'), 'Must be a valid email')

  let locale: 'en' | 'id' | undefined
  const rawLocale = str(obj, 'locale', at('locale'), fail, {})
  if (rawLocale !== undefined) {
    if (rawLocale === 'en' || rawLocale === 'id') locale = rawLocale
    else fail(at('locale'), 'Must be en or id')
  }

  if (externalId === undefined) return undefined
  return {
    externalId,
    ...(accountCreatedAt ? { accountCreatedAt } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(locale ? { locale } : {}),
  }
}

const MEDIA_HASH = /^sha256:[0-9a-f]{64}$/

function isMedia(v: unknown): v is string {
  if (typeof v !== 'string') return false
  return (v.startsWith('https://') && v.length > 'https://'.length && v.length <= 2048) || MEDIA_HASH.test(v)
}

function contentItem(item: unknown, path: string, fail: Fail): ContentItem | undefined {
  if (typeof item === 'string') return { text: item }
  if (!isObject(item)) return void fail(path, 'Must be a string or an object')
  const text = str(item, 'text', join(path, 'text'), fail, { required: true })
  const author = str(item, 'author', join(path, 'author'), fail, { min: 1, max: 128 })
  const at = timestamp(item, 'at', join(path, 'at'), fail)
  if (text === undefined) return undefined
  return { text, ...(author !== undefined ? { author } : {}), ...(at ? { at } : {}) }
}

function evidenceOf(body: Obj, fail: Fail): ReportInput['evidence'] | undefined {
  const obj = objectField(body, 'evidence', 'evidence', fail, true)
  if (!obj) return undefined

  const kind = str(obj, 'kind', 'evidence.kind', fail, { required: true, min: 1, max: 64 })

  const content: ContentItem[] = []
  const rawContent = arrayField(obj, 'content', 'evidence.content', fail, true, 50)
  rawContent?.forEach((item, i) => {
    const parsed = contentItem(item, `evidence.content[${i}]`, fail)
    if (parsed) content.push(parsed)
  })

  const media: string[] = []
  const rawMedia = arrayField(obj, 'media', 'evidence.media', fail, false, 20)
  rawMedia?.forEach((item, i) => {
    if (isMedia(item)) media.push(item)
    else fail(`evidence.media[${i}]`, 'Must be an https URL or a sha256 hash')
  })

  const authorId = str(obj, 'author_id', 'evidence.author_id', fail, { min: 1, max: 128 })

  const metadata: Record<string, string | number | boolean> = {}
  const rawMetadata = objectField(obj, 'metadata', 'evidence.metadata', fail, false)
  if (rawMetadata) {
    const keys = Object.keys(rawMetadata)
    if (keys.length > 50) fail('evidence.metadata', 'Too many items')
    else {
      for (const k of keys) {
        const v = rawMetadata[k]
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') metadata[k] = v
        else fail(`evidence.metadata.${k}`, 'Must be a string, number or boolean')
      }
    }
  }

  if (kind === undefined) return undefined
  return { kind, content, media, ...(authorId !== undefined ? { authorId } : {}), metadata }
}

const IDENTIFIER_HASH = /^hm[1-9]\d*_[0-9a-f]{64}$/

function identifiersOf(body: Obj, fail: Fail): ReportInput['identifiers'] | undefined {
  const obj = objectField(body, 'identifiers', 'identifiers', fail, false)
  if (!obj) return {}
  const hash = (key: string) => {
    const path = `identifiers.${key}`
    const v = str(obj, key, path, fail, {})
    if (v !== undefined && !IDENTIFIER_HASH.test(v)) return void fail(path, 'Must be an identifier hash')
    return v
  }
  const phoneHash = hash('phone_hash')
  const emailHash = hash('email_hash')
  const deviceHash = hash('device_hash')
  return {
    ...(phoneHash !== undefined ? { phoneHash } : {}),
    ...(emailHash !== undefined ? { emailHash } : {}),
    ...(deviceHash !== undefined ? { deviceHash } : {}),
  }
}
