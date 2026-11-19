import type { FieldError } from '@flagwise/kernel'
import { describe, expect, it } from 'vitest'
import { validateReport, type ValidationResult } from '../src/domain/validate-report.ts'

const HASH = `hm1_${'9c2f'.repeat(16)}`

/** The example report from the API docs. */
function body(): Record<string, any> {
  return {
    reporter: { external_id: 'u_1029', account_created_at: '2025-04-11T08:00:00Z', email: 'jane@example.com', locale: 'en' },
    reported: { external_id: 'u_5531', account_created_at: '2026-10-30T22:14:00Z', email: 'b@example.com', locale: 'id' },
    category: 'asking_for_money',
    text: 'He asked me to transfer $200 for a plane ticket',
    evidence: {
      kind: 'message',
      content: [
        { text: 'hey, I am at the airport right now', author: 'u_5531', at: '2026-11-02T10:01:00Z' },
        { text: 'can you send me $200 first? I will pay you back', author: 'u_5531', at: '2026-11-02T10:03:00Z' },
      ],
      media: [],
      author_id: 'u_5531',
      metadata: { conversation_id: 'c_88' },
    },
    identifiers: { phone_hash: HASH, email_hash: HASH },
  }
}

/** The smallest valid report. */
function minimal(): Record<string, any> {
  return {
    reporter: { external_id: 'u_1' },
    reported: { external_id: 'u_2' },
    category: 'spam',
    evidence: { kind: 'profile', content: [] },
  }
}

const sorted = (errors: readonly FieldError[]) =>
  [...errors].sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message))

function errorsOf(result: ValidationResult): FieldError[] {
  if (result.ok) throw new Error('expected validation to fail')
  expect(result.status).toBe(422)
  return sorted(result.errors)
}

const valid = (b: unknown) => validateReport(b, 1000)
const errs = (b: unknown) => errorsOf(validateReport(b, 1000))
const one = (path: string, message: string) => [{ path, message }]

function mutate(fn: (b: Record<string, any>) => void, base = minimal) {
  const b = base()
  fn(b)
  return b
}

describe('valid reports', () => {
  it('accepts the example report and converts it', () => {
    expect(valid(body())).toEqual({
      ok: true,
      value: {
        reporter: {
          externalId: 'u_1029',
          accountCreatedAt: new Date('2025-04-11T08:00:00Z'),
          email: 'jane@example.com',
          locale: 'en',
        },
        reported: {
          externalId: 'u_5531',
          accountCreatedAt: new Date('2026-10-30T22:14:00Z'),
          email: 'b@example.com',
          locale: 'id',
        },
        category: 'asking_for_money',
        text: 'He asked me to transfer $200 for a plane ticket',
        evidence: {
          kind: 'message',
          content: [
            { text: 'hey, I am at the airport right now', author: 'u_5531', at: new Date('2026-11-02T10:01:00Z') },
            { text: 'can you send me $200 first? I will pay you back', author: 'u_5531', at: new Date('2026-11-02T10:03:00Z') },
          ],
          media: [],
          authorId: 'u_5531',
          metadata: { conversation_id: 'c_88' },
        },
        identifiers: { phoneHash: HASH, emailHash: HASH },
      },
    })
  })

  it('fills defaults and leaves missing optional fields out', () => {
    const r = valid(minimal())
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.value).toEqual({
      reporter: { externalId: 'u_1' },
      reported: { externalId: 'u_2' },
      category: 'spam',
      evidence: { kind: 'profile', content: [], media: [], metadata: {} },
      identifiers: {},
    })
    expect(Object.keys(r.value).sort()).toEqual(['category', 'evidence', 'identifiers', 'reported', 'reporter'])
    expect(Object.keys(r.value.reporter)).toEqual(['externalId'])
    expect(Object.keys(r.value.evidence).sort()).toEqual(['content', 'kind', 'media', 'metadata'])
  })

  it('turns string content items into objects and keeps empty text', () => {
    const r = valid(mutate((b) => (b.evidence.content = ['hello', { text: '' }, { text: 'hi', author: 'u_9' }])))
    expect(r.ok && r.value.evidence.content).toEqual([{ text: 'hello' }, { text: '' }, { text: 'hi', author: 'u_9' }])
  })

  it('treats null as missing', () => {
    const r = valid(mutate((b) => Object.assign(b, { text: null, identifiers: null, reporter: { external_id: 'u_1', email: null } })))
    expect(r.ok).toBe(true)
    expect(r.ok && Object.keys(r.value.reporter)).toEqual(['externalId'])
  })

  it('ignores unknown fields', () => {
    const r = valid(mutate((b) => Object.assign(b, { extra: 1, reporter: { external_id: 'u_1', nickname: 'x' } })))
    expect(r.ok).toBe(true)
  })

  it('accepts media URLs and hashes, and metadata scalars', () => {
    const r = valid(
      mutate((b) => {
        b.evidence.media = ['https://cdn.example.com/a.jpg', `sha256:${'ab'.repeat(32)}`]
        b.evidence.metadata = { s: 'x', n: 3.5, b: false }
      }),
    )
    expect(r.ok && r.value.evidence.media).toEqual(['https://cdn.example.com/a.jpg', `sha256:${'ab'.repeat(32)}`])
    expect(r.ok && r.value.evidence.metadata).toEqual({ s: 'x', n: 3.5, b: false })
  })
})

describe('size', () => {
  it('rejects bodies over 64 KB with 413 before checking anything else', () => {
    expect(validateReport({}, 65_537)).toEqual({ ok: false, status: 413, errors: [{ path: '', message: 'Payload exceeds 64 KB' }] })
  })

  it('accepts exactly 64 KB', () => {
    expect(validateReport(minimal(), 65_536).ok).toBe(true)
  })
})

describe('shape', () => {
  it.each([null, [], 'report', 42, true, undefined])('rejects a non-object body %j', (b) => {
    expect(errs(b)).toEqual(one('', 'Must be an object'))
  })

  it('reports every missing required field', () => {
    expect(errs({})).toEqual(
      sorted([
        { path: 'category', message: 'Required' },
        { path: 'evidence', message: 'Required' },
        { path: 'reported', message: 'Required' },
        { path: 'reporter', message: 'Required' },
      ]),
    )
    expect(errs({ reporter: {}, reported: {}, category: 'x', evidence: {} })).toEqual(
      sorted([
        { path: 'evidence.content', message: 'Required' },
        { path: 'evidence.kind', message: 'Required' },
        { path: 'reported.external_id', message: 'Required' },
        { path: 'reporter.external_id', message: 'Required' },
      ]),
    )
  })

  it('collects errors from several fields at once', () => {
    const b = mutate((x) => {
      x.category = ''
      x.reporter.locale = 'fr'
      x.evidence.content = [7]
    })
    expect(errs(b)).toEqual(
      sorted([
        { path: 'category', message: 'Must not be empty' },
        { path: 'evidence.content[0]', message: 'Must be a string or an object' },
        { path: 'reporter.locale', message: 'Must be en or id' },
      ]),
    )
  })

  it.each([
    ['reporter', 'u_1', 'Must be an object'],
    ['reporter', [], 'Must be an object'],
    ['category', 5, 'Must be a string'],
    ['text', ['x'], 'Must be a string'],
    ['evidence', 'msg', 'Must be an object'],
    ['identifiers', 'x', 'Must be an object'],
  ])('rejects %s = %j', (field, value, message) => {
    expect(errs(mutate((b) => (b[field] = value)))).toEqual(one(field, message))
  })
})

describe('parties', () => {
  it.each([
    [{ external_id: 7 }, 'reporter.external_id', 'Must be a string'],
    [{ external_id: '' }, 'reporter.external_id', 'Must not be empty'],
    [{ external_id: 'x'.repeat(129) }, 'reporter.external_id', 'Too long'],
    [{ external_id: 'u', email: 'a@b' + 'c'.repeat(252) }, 'reporter.email', 'Too long'],
    [{ external_id: 'u', email: 'not an email' }, 'reporter.email', 'Must be a valid email'],
    [{ external_id: 'u', email: 'a@@b.c' }, 'reporter.email', 'Must be a valid email'],
    [{ external_id: 'u', email: '@b.c' }, 'reporter.email', 'Must be a valid email'],
    [{ external_id: 'u', email: 'a@' }, 'reporter.email', 'Must be a valid email'],
    [{ external_id: 'u', email: 3 }, 'reporter.email', 'Must be a string'],
    [{ external_id: 'u', locale: 'EN' }, 'reporter.locale', 'Must be en or id'],
    [{ external_id: 'u', locale: 1 }, 'reporter.locale', 'Must be a string'],
    [{ external_id: 'u', account_created_at: 1700000000 }, 'reporter.account_created_at', 'Must be a string'],
  ])('rejects reporter %j', (party, path, message) => {
    expect(errs(mutate((b) => (b.reporter = party)))).toEqual(one(path, message))
  })

  it('accepts the length limits exactly', () => {
    const r = valid(mutate((b) => (b.reported = { external_id: 'x'.repeat(128), email: 'a@b' + 'c'.repeat(251) })))
    expect(r.ok).toBe(true)
  })

  it('checks the reported party too', () => {
    expect(errs(mutate((b) => (b.reported = { external_id: '' })))).toEqual(one('reported.external_id', 'Must not be empty'))
  })
})

describe('category and text', () => {
  it('limits category to 64 and text to 5000 characters', () => {
    expect(valid(mutate((b) => Object.assign(b, { category: 'c'.repeat(64), text: 't'.repeat(5000) }))).ok).toBe(true)
    expect(errs(mutate((b) => (b.category = 'c'.repeat(65))))).toEqual(one('category', 'Too long'))
    expect(errs(mutate((b) => (b.text = 't'.repeat(5001))))).toEqual(one('text', 'Too long'))
  })

  it('allows empty text', () => {
    expect(valid(mutate((b) => (b.text = ''))).ok).toBe(true)
  })
})

describe('evidence', () => {
  it('allows 50 content items and rejects 51', () => {
    expect(valid(mutate((b) => (b.evidence.content = Array(50).fill('x')))).ok).toBe(true)
    expect(errs(mutate((b) => (b.evidence.content = Array(51).fill('x'))))).toEqual(one('evidence.content', 'Too many items'))
  })

  it('allows 20 media items and rejects 21', () => {
    const url = 'https://cdn.example.com/a.jpg'
    expect(valid(mutate((b) => (b.evidence.media = Array(20).fill(url)))).ok).toBe(true)
    expect(errs(mutate((b) => (b.evidence.media = Array(21).fill(url))))).toEqual(one('evidence.media', 'Too many items'))
  })

  it.each([
    [{ kind: '' }, 'evidence.kind', 'Must not be empty'],
    [{ kind: 'k'.repeat(65) }, 'evidence.kind', 'Too long'],
    [{ content: 'hello' }, 'evidence.content', 'Must be an array'],
    [{ content: { text: 'x' } }, 'evidence.content', 'Must be an array'],
    [{ content: [{ author: 'u' }] }, 'evidence.content[0].text', 'Required'],
    [{ content: ['ok', { text: 5 }] }, 'evidence.content[1].text', 'Must be a string'],
    [{ content: [{ text: 'x', author: '' }] }, 'evidence.content[0].author', 'Must not be empty'],
    [{ content: [{ text: 'x', author: 'a'.repeat(129) }] }, 'evidence.content[0].author', 'Too long'],
    [{ content: [{ text: 'x', at: 'yesterday' }] }, 'evidence.content[0].at', 'Must be an RFC 3339 timestamp'],
    [{ content: [null] }, 'evidence.content[0]', 'Must be a string or an object'],
    [{ content: [['x']] }, 'evidence.content[0]', 'Must be a string or an object'],
    [{ media: 'https://x.com/a' }, 'evidence.media', 'Must be an array'],
    [{ media: ['http://cdn.example.com/a.jpg'] }, 'evidence.media[0]', 'Must be an https URL or a sha256 hash'],
    [{ media: [`https://x.com/${'a'.repeat(2035)}`] }, 'evidence.media[0]', 'Must be an https URL or a sha256 hash'],
    [{ media: [`sha256:${'AB'.repeat(32)}`] }, 'evidence.media[0]', 'Must be an https URL or a sha256 hash'],
    [{ media: [`sha256:${'ab'.repeat(31)}`] }, 'evidence.media[0]', 'Must be an https URL or a sha256 hash'],
    [{ media: [42] }, 'evidence.media[0]', 'Must be an https URL or a sha256 hash'],
    [{ author_id: '' }, 'evidence.author_id', 'Must not be empty'],
    [{ metadata: ['x'] }, 'evidence.metadata', 'Must be an object'],
    [{ metadata: { nested: { a: 1 } } }, 'evidence.metadata.nested', 'Must be a string, number or boolean'],
    [{ metadata: { gone: null } }, 'evidence.metadata.gone', 'Must be a string, number or boolean'],
  ])('rejects evidence %j', (patch, path, message) => {
    expect(errs(mutate((b) => Object.assign(b.evidence, patch)))).toEqual(one(path, message))
  })

  it('accepts an https URL of exactly 2048 characters', () => {
    const url = `https://x.com/${'a'.repeat(2048 - 'https://x.com/'.length)}`
    expect(url).toHaveLength(2048)
    expect(valid(mutate((b) => (b.evidence.media = [url]))).ok).toBe(true)
  })

  it('allows 50 metadata keys and rejects 51', () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]))
    expect(valid(mutate((b) => (b.evidence.metadata = keys(50)))).ok).toBe(true)
    expect(errs(mutate((b) => (b.evidence.metadata = keys(51))))).toEqual(one('evidence.metadata', 'Too many items'))
  })
})

describe('identifiers', () => {
  it.each([
    ['phone_hash', 'hm1_short'],
    ['email_hash', `hm0_${'a'.repeat(64)}`],
    ['device_hash', `hm1_${'A'.repeat(64)}`],
    ['phone_hash', `sha_${'a'.repeat(64)}`],
  ])('rejects %s = %j', (key, value) => {
    expect(errs(mutate((b) => (b.identifiers = { [key]: value })))).toEqual(one(`identifiers.${key}`, 'Must be an identifier hash'))
  })

  it('rejects a non-string hash by type', () => {
    expect(errs(mutate((b) => (b.identifiers = { phone_hash: 1 })))).toEqual(one('identifiers.phone_hash', 'Must be a string'))
  })

  it('converts the keys to camelCase', () => {
    const r = valid(mutate((b) => (b.identifiers = { device_hash: HASH })))
    expect(r.ok && r.value.identifiers).toEqual({ deviceHash: HASH })
  })
})

describe('timestamps', () => {
  it.each([
    ['2026-11-03T09:00:00Z', '2026-11-03T09:00:00.000Z'],
    ['2026-11-03T09:00:00.5Z', '2026-11-03T09:00:00.500Z'],
    ['2026-11-03T09:00:00.123456789+07:00', '2026-11-03T02:00:00.123Z'],
    ['2026-11-03T23:59:59-03:30', '2026-11-04T03:29:59.000Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
  ])('accepts %s', (ts, iso) => {
    const r = valid(mutate((b) => (b.reporter.account_created_at = ts)))
    expect(r.ok && r.value.reporter.accountCreatedAt?.toISOString()).toBe(iso)
  })

  it.each([
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-11-00T00:00:00Z',
    '2026-11-03T24:00:00Z',
    '2026-11-03T09:60:00Z',
    '2026-11-03T09:00:60Z',
    '2026-11-03 09:00:00Z',
    '2026-11-03t09:00:00Z',
    '2026-11-03T09:00:00z',
    '2026-11-03T09:00:00',
    '2026-11-03T09:00:00.Z',
    '2026-11-03T09:00:00.1234567890Z',
    '2026-11-03T09:00:00+24:00',
    '2026-11-03T09:00:00+07:60',
    '2026-11-03T09:00:00+0700',
    '2026-11-03',
    '26-11-03T09:00:00Z',
  ])('rejects %s', (ts) => {
    expect(errs(mutate((b) => (b.reporter.account_created_at = ts)))).toEqual(
      one('reporter.account_created_at', 'Must be an RFC 3339 timestamp'),
    )
  })
})
