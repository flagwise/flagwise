// An app's categories: what its report screen offers, each mapped to global categories. One with
// its own severity or SLA is a custom category; one without is a label for the global categories it
// maps to. The key is what the tenant's backend sends as a report's `category`.

import { categoriesNamed, DEFAULT_POLICY, GLOBAL_GROUPS, globalCategory, type GlobalSeverity, type PolicyCategory, type PolicyLlmSettings } from '@flagwise/contracts'
import type { FieldError } from '@flagwise/kernel'

/**
 * An app's category. `key` is lowercase letters, digits and underscores, starting with a letter, at
 * most 64 characters. One with its own severity or SLA is a custom category.
 */
export type AppCategory = PolicyCategory

/** How an app classifies: with the install's LLM or by rules only, and what happens when the LLM fails. */
export type LlmSettings = PolicyLlmSettings

export const DEFAULT_LLM_SETTINGS: LlmSettings = DEFAULT_POLICY.llm

export const MAX_CATEGORIES = 100
export const MAX_SLA_HOURS = 720
const KEY = /^[a-z][a-z0-9_]{0,63}$/
const MAX_LABEL = 80
const MAX_MAPS_TO = 20
const SEVERITIES: readonly string[] = ['P0', 'P1', 'P2']
const GROUPS = new Set(GLOBAL_GROUPS)

/** True when the category is mapped to no global category: left out of the DSA export, counted as Other. */
export function isUnmapped(category: AppCategory): boolean {
  return category.mapsTo.length === 0
}

/** True when the category maps to a P0 global category, by id or by its group. */
export function mapsToP0(category: Pick<AppCategory, 'mapsTo'>): boolean {
  return categoriesNamed(category.mapsTo).some((c) => c.severity === 'P0')
}

/**
 * Reads an app's category list from its API form (`[{ key, label: { en, id? }, maps_to?,
 * severity?, sla_hours?, enabled? }]`), keeping its order. Every problem is reported, at most one
 * per field, with paths under `path` (such as `data[2].severity`):
 *
 * - at most 100 categories, each key unique and of the key form
 * - `label.en` 1 to 80 characters, `label.id` the same when given
 * - `maps_to` (default empty) up to 20 unique global groups or global category ids
 * - `severity` P0, P1 or P2, and `sla_hours` an integer from 1 to 720, or null (the default). With
 *   either, the category is a custom one and maps to at most one global category id, never a group,
 *   so its cases have one global category. Mapped to a P0 category, its severity can only be P0.
 * - `enabled` true or false (default true)
 *
 * Text is trimmed; unknown fields are ignored.
 */
export function parseCategories(input: unknown, path = 'data'): { readonly ok: true; readonly categories: readonly AppCategory[] } | { readonly ok: false; readonly errors: readonly FieldError[] } {
  const errors: FieldError[] = []
  if (!Array.isArray(input)) return { ok: false, errors: [{ path, message: 'A list of categories' }] }
  if (input.length > MAX_CATEGORIES) return { ok: false, errors: [{ path, message: `At most ${MAX_CATEGORIES} categories` }] }

  const categories: AppCategory[] = []
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
      en = text(l.en, `${at}.label.en`, true, errors)
      id = text(l.id, `${at}.label.id`, false, errors)
    }

    const mapsTo = o.maps_to ?? []
    let mapsOk = false
    if (!Array.isArray(mapsTo) || mapsTo.length > MAX_MAPS_TO) {
      errors.push({ path: `${at}.maps_to`, message: `A list of up to ${MAX_MAPS_TO} global groups or global category ids` })
    } else {
      const bad = mapsTo.findIndex((c, j) => typeof c !== 'string' || !(GROUPS.has(c) || globalCategory(c)) || mapsTo.indexOf(c) !== j)
      if (bad >= 0) errors.push({ path: `${at}.maps_to[${bad}]`, message: 'Not a global group or a global category id, or listed twice' })
      else mapsOk = true
    }

    const severity = o.severity ?? null
    const severityOk = severity === null || (typeof severity === 'string' && SEVERITIES.includes(severity))
    if (!severityOk) errors.push({ path: `${at}.severity`, message: 'P0, P1, P2 or null' })
    const slaHours = o.sla_hours ?? null
    const slaOk = slaHours === null || (typeof slaHours === 'number' && Number.isInteger(slaHours) && slaHours >= 1 && slaHours <= MAX_SLA_HOURS)
    if (!slaOk) errors.push({ path: `${at}.sla_hours`, message: `Whole hours from 1 to ${MAX_SLA_HOURS}, or null` })

    const refs = mapsOk ? (mapsTo as string[]) : []
    if (mapsOk && severityOk && slaOk && (severity !== null || slaHours !== null)) {
      if (refs.length > 1 || (refs.length === 1 && !globalCategory(refs[0]!))) {
        errors.push({ path: `${at}.maps_to`, message: 'A category with its own severity or SLA maps to at most one global category id' })
      } else if (severity !== null && severity !== 'P0' && mapsToP0({ mapsTo: refs })) {
        errors.push({ path: `${at}.severity`, message: `${refs[0]} is a P0 category: its severity stays P0` })
      }
    }

    const enabled = o.enabled ?? true
    if (typeof enabled !== 'boolean') errors.push({ path: `${at}.enabled`, message: 'Must be true or false' })

    categories.push({
      key: key as string,
      label: { en: en ?? '', id },
      mapsTo: refs,
      severity: severityOk ? (severity as GlobalSeverity | null) : null,
      slaHours: slaOk ? (slaHours as number | null) : null,
      enabled: enabled !== false,
    })
  })

  return errors.length ? { ok: false, errors } : { ok: true, categories }
}

/** Trimmed text of 1 to 80 characters; null when absent (or null) and not required. */
function text(value: unknown, path: string, required: boolean, errors: FieldError[]): string | null {
  if (value === undefined || value === null) {
    if (required) errors.push({ path, message: `Text of 1 to ${MAX_LABEL} characters` })
    return null
  }
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '' || trimmed.length > MAX_LABEL) {
    errors.push({ path, message: `Text of 1 to ${MAX_LABEL} characters` })
    return null
  }
  return trimmed
}
