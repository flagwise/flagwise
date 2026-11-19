// Errors and their application/problem+json form.

const STATUS_AND_TITLE: Record<ErrorCode, readonly [number, string]> = {
  invalid_request: [400, 'Invalid request'],
  unauthorized: [401, 'Unauthorized'],
  forbidden: [403, 'Forbidden'],
  not_found: [404, 'Not found'],
  conflict: [409, 'Conflict'],
  gone: [410, 'Gone'],
  payload_too_large: [413, 'Payload too large'],
  validation_failed: [422, 'Validation failed'],
  rate_limited: [429, 'Rate limited'],
  quota_exceeded: [429, 'Quota exceeded'],
  unavailable: [503, 'Service unavailable'],
  internal_error: [500, 'Internal error'],
}

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'payload_too_large'
  | 'validation_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'unavailable'
  | 'internal_error'

export interface FieldError {
  /** JSON path of the offending field, e.g. `evidence.content[3].text`. */
  readonly path: string
  readonly message: string
}

export interface FlagwiseErrorOptions {
  readonly errors?: readonly FieldError[]
  readonly retryAfterSeconds?: number
}

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
  readonly errors?: readonly FieldError[]
  readonly request_id: string
}

/**
 * An error with a code, an HTTP status and optional field errors.
 *
 * `name` is 'FlagwiseError'; `status` comes from the code; `message` is the detail, or the title
 * when there is no detail; `errors` defaults to an empty array.
 *
 *     code               status  title
 *     invalid_request    400     Invalid request
 *     unauthorized       401     Unauthorized
 *     forbidden          403     Forbidden
 *     not_found          404     Not found
 *     conflict           409     Conflict
 *     gone               410     Gone
 *     payload_too_large  413     Payload too large
 *     validation_failed  422     Validation failed
 *     rate_limited       429     Rate limited
 *     quota_exceeded     429     Quota exceeded
 *     unavailable        503     Service unavailable
 *     internal_error     500     Internal error
 */
export class FlagwiseError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly detail: string | undefined
  readonly errors: readonly FieldError[]
  readonly retryAfterSeconds: number | undefined

  constructor(code: ErrorCode, detail?: string, opts?: FlagwiseErrorOptions) {
    const [status, title] = STATUS_AND_TITLE[code]
    super(detail ?? title)
    this.name = 'FlagwiseError'
    this.code = code
    this.status = status
    this.detail = detail
    this.errors = opts?.errors ?? []
    this.retryAfterSeconds = opts?.retryAfterSeconds
  }
}

/**
 * The response body for an error:
 * `{ type: 'https://flagwise.dev/errors/<code>', title, status, detail?, errors?, request_id }`.
 *
 * `detail` is present only when the error has one, and `errors` only when there is at least one
 * field error. Any value that is not a FlagwiseError (a plain Error, a string, undefined, ...)
 * becomes internal_error with no `detail`, so internal messages never leak.
 */
export function toProblem(err: unknown, requestId: string): Problem {
  const code: ErrorCode = err instanceof FlagwiseError ? err.code : 'internal_error'
  const [status, title] = STATUS_AND_TITLE[code]
  const detail = err instanceof FlagwiseError ? err.detail : undefined
  const errors = err instanceof FlagwiseError ? err.errors : []
  return {
    type: `https://flagwise.dev/errors/${code}`,
    title,
    status,
    ...(detail !== undefined && { detail }),
    ...(errors.length > 0 && { errors }),
    request_id: requestId,
  }
}
