import { describe, expect, it } from 'vitest'
import { FlagwiseError, toProblem, type ErrorCode } from '../src/index.ts'

const table: [ErrorCode, number, string][] = [
  ['invalid_request', 400, 'Invalid request'],
  ['unauthorized', 401, 'Unauthorized'],
  ['forbidden', 403, 'Forbidden'],
  ['not_found', 404, 'Not found'],
  ['conflict', 409, 'Conflict'],
  ['gone', 410, 'Gone'],
  ['payload_too_large', 413, 'Payload too large'],
  ['validation_failed', 422, 'Validation failed'],
  ['rate_limited', 429, 'Rate limited'],
  ['quota_exceeded', 429, 'Quota exceeded'],
  ['unavailable', 503, 'Service unavailable'],
  ['internal_error', 500, 'Internal error'],
]

describe('FlagwiseError', () => {
  it.each(table)('%s has status %i', (code, status) => {
    const err = new FlagwiseError(code)
    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
  })

  it('is an Error named FlagwiseError', () => {
    const err = new FlagwiseError('not_found', 'No case case_123')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(FlagwiseError)
    expect(err.name).toBe('FlagwiseError')
  })

  it('uses the detail as message, or the title when there is none', () => {
    expect(new FlagwiseError('conflict', 'Case already decided').message).toBe('Case already decided')
    expect(new FlagwiseError('conflict').message).toBe('Conflict')
  })

  it('keeps detail, field errors and retry-after', () => {
    const err = new FlagwiseError('validation_failed', 'Invalid report', {
      errors: [{ path: 'evidence.content[3].text', message: 'Required' }],
    })
    expect(err.detail).toBe('Invalid report')
    expect(err.errors).toEqual([{ path: 'evidence.content[3].text', message: 'Required' }])
    expect(err.retryAfterSeconds).toBeUndefined()
    expect(new FlagwiseError('rate_limited', undefined, { retryAfterSeconds: 7 }).retryAfterSeconds).toBe(7)
  })

  it('defaults to no detail and no field errors', () => {
    const err = new FlagwiseError('forbidden')
    expect(err.detail).toBeUndefined()
    expect(err.errors).toEqual([])
  })
})

describe('toProblem', () => {
  it.each(table)('maps %s to type, title and status', (code, status, title) => {
    expect(toProblem(new FlagwiseError(code), 'req_1')).toEqual({
      type: `https://flagwise.dev/errors/${code}`,
      title,
      status,
      request_id: 'req_1',
    })
  })

  it('includes detail and field errors when present', () => {
    const err = new FlagwiseError('validation_failed', 'Invalid report', {
      errors: [
        { path: 'reported.external_id', message: 'Required' },
        { path: 'evidence.media', message: 'At most 20 items' },
      ],
    })
    expect(toProblem(err, 'req_2')).toEqual({
      type: 'https://flagwise.dev/errors/validation_failed',
      title: 'Validation failed',
      status: 422,
      detail: 'Invalid report',
      errors: [
        { path: 'reported.external_id', message: 'Required' },
        { path: 'evidence.media', message: 'At most 20 items' },
      ],
      request_id: 'req_2',
    })
  })

  it('omits the keys entirely when there is no detail or field error', () => {
    const problem = toProblem(new FlagwiseError('not_found'), 'req_3')
    expect(Object.keys(problem).sort()).toEqual(['request_id', 'status', 'title', 'type'])
  })

  it.each([
    ['a plain Error', new Error('connection to db-internal:5432 refused')],
    ['a string', 'boom'],
    ['undefined', undefined],
    ['an object', { code: 'not_found' }],
  ])('turns %s into internal_error without leaking it', (_label, value) => {
    expect(toProblem(value, 'req_4')).toEqual({
      type: 'https://flagwise.dev/errors/internal_error',
      title: 'Internal error',
      status: 500,
      request_id: 'req_4',
    })
  })
})
