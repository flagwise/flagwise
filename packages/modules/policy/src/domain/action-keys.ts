// The action keys an app registers: the sanctions its moderators can pick, which the tenant's
// backend carries out when Flagwise requests them.

import { isActionKeyCategory, type PolicyActionKey } from '@flagwise/contracts'
import type { FieldError } from '@flagwise/kernel'

/**
 * An action key: a sanction moderators can pick. `key` is lowercase letters, digits and
 * underscores, starting with a letter, at most 64 characters; `autoAllowed` (requested without a
 * moderator) is only for reversible protective actions, so it needs a reverse key; `categories`
 * are `*` (every category), global groups (such as `scams_fraud`) or global category ids (such as
 * `scams_fraud.romance_scam`).
 */
export type ActionKey = PolicyActionKey

export const MAX_ACTION_KEYS = 50
const KEY = /^[a-z][a-z0-9_]{0,63}$/
const MAX_LABEL = 80
const MAX_DESCRIPTION = 500
const MAX_CATEGORIES = 100

/**
 * Reads an app's action key list from its API form (`[{ key, label: { en, id? }, description?,
 * reverse_key?, auto_allowed?, categories }]`), keeping its order. Every problem is reported, at
 * most one per field, with paths under `path` (such as `data[2].reverse_key`):
 *
 * - at most 50 keys, each unique and of the key form
 * - `label.en` 1 to 80 characters, `label.id` the same when given; `description` at most 500
 * - `reverse_key` another key of the same list; `auto_allowed` true only with a reverse key
 * - `categories` 1 to 100 unique entries, each `*`, a global group or a global category id
 *
 * Text is trimmed; unknown fields are ignored.
 */
export function parseActionKeys(input: unknown, path = 'data'): { readonly ok: true; readonly keys: readonly ActionKey[] } | { readonly ok: false; readonly errors: readonly FieldError[] } {
  const errors: FieldError[] = []
  if (!Array.isArray(input)) return { ok: false, errors: [{ path, message: 'A list of action keys' }] }
  if (input.length > MAX_ACTION_KEYS) return { ok: false, errors: [{ path, message: `At most ${MAX_ACTION_KEYS} action keys` }] }

  const keys: ActionKey[] = []
  const seen = new Set<string>()
  input.forEach((item, i) => {
    const at = `${path}[${i}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push({ path: at, message: 'Must be an object' })
      return
    }
    const o = item as Record<string, unknown>
    const key = o.key
    if (typeof key !== 'string' || !KEY.test(key)) errors.push({ path: `${at}.key`, message: 'Lowercase letters, digits and underscores, starting with a letter; at most 64 characters' })
    else if (seen.has(key)) errors.push({ path: `${at}.key`, message: `${key} is listed twice` })
    else seen.add(key)

    const label = o.label
    let en: string | null = null
    let id: string | null = null
    if (typeof label !== 'object' || label === null || Array.isArray(label)) errors.push({ path: `${at}.label`, message: 'An object with en (and optionally id)' })
    else {
      const l = label as Record<string, unknown>
      en = text(l.en, `${at}.label.en`, MAX_LABEL, true, errors)
      id = text(l.id, `${at}.label.id`, MAX_LABEL, false, errors)
    }
    const description = text(o.description, `${at}.description`, MAX_DESCRIPTION, false, errors)

    const reverseKey = o.reverse_key ?? null
    if (reverseKey !== null && typeof reverseKey !== 'string') errors.push({ path: `${at}.reverse_key`, message: 'Another action key of the list, or null' })
    const autoAllowed = o.auto_allowed ?? false
    if (typeof autoAllowed !== 'boolean') errors.push({ path: `${at}.auto_allowed`, message: 'Must be true or false' })
    else if (autoAllowed && reverseKey === null) errors.push({ path: `${at}.auto_allowed`, message: 'Only a reversible action can run without a moderator: give it a reverse_key' })

    const categories = o.categories
    if (!Array.isArray(categories) || categories.length === 0 || categories.length > MAX_CATEGORIES) {
      errors.push({ path: `${at}.categories`, message: `A list of 1 to ${MAX_CATEGORIES} categories: *, a global group or a global category id` })
    } else {
      const bad = categories.findIndex((c, j) => typeof c !== 'string' || !isActionKeyCategory(c) || categories.indexOf(c) !== j)
      if (bad >= 0) errors.push({ path: `${at}.categories[${bad}]`, message: 'Not *, a global group or a global category id, or listed twice' })
    }

    keys.push({
      key: key as string,
      label: { en: en ?? '', id },
      description,
      reverseKey: reverseKey as string | null,
      autoAllowed: autoAllowed === true,
      categories: Array.isArray(categories) ? (categories as string[]) : [],
    })
  })

  // Checked once every key is known, so a reverse key may come later in the list.
  keys.forEach((k, i) => {
    if (typeof k.reverseKey !== 'string') return
    if (k.reverseKey === k.key) errors.push({ path: `${path}[${i}].reverse_key`, message: 'An action cannot reverse itself' })
    else if (!seen.has(k.reverseKey)) errors.push({ path: `${path}[${i}].reverse_key`, message: `${k.reverseKey} is not in the list` })
  })

  return errors.length ? { ok: false, errors } : { ok: true, keys }
}

/** Trimmed text of 1 to `max` characters; null when absent (or null) and not required. */
function text(value: unknown, path: string, max: number, required: boolean, errors: FieldError[]): string | null {
  if (value === undefined || value === null) {
    if (required) errors.push({ path, message: `Text of 1 to ${max} characters` })
    return null
  }
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '' || trimmed.length > max) {
    errors.push({ path, message: `Text of 1 to ${max} characters` })
    return null
  }
  return trimmed
}
