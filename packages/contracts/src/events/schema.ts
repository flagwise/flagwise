// The building blocks of event schemas. Event data travels as JSON, so a schema describes the JSON
// form: times are RFC 3339 strings. Contract schemas only describe data (no transforms or
// refinements), so each one converts to JSON Schema as it is.

import { z } from 'zod'

/** A non-empty id. */
export const id = z.string().min(1)

/** An RFC 3339 time in UTC, as Date#toJSON writes it. */
export const time = z.iso.datetime()

export const severity = z.enum(['P0', 'P1', 'P2'])

export const ids = z.array(id)

/** Text in English, and Indonesian when given. */
export const label = z.strictObject({ en: z.string(), id: z.string().nullable() })

export { z }
