// An app's policy, the rulebook its moderation runs on: its categories, its action keys and its LLM
// settings, per mode. The policy service owns it and publishes the whole policy on every change
// (`policy.updated`), with one integer version per app and mode; every other service that reads it
// keeps its own copy built from those events, and reads the copy through these helpers.

import { id, label, severity, z } from './events/schema.ts'
import { globalCategory, GLOBAL_CATEGORIES, type GlobalSeverity } from './taxonomy.ts'

export interface PolicyCategory {
  /** What the tenant's backend sends as a report's `category`. */
  readonly key: string
  readonly label: { readonly en: string; readonly id: string | null }
  /** Global groups or global category ids; empty when unmapped. */
  readonly mapsTo: readonly string[]
  /** Its own severity; null to take the global category's. */
  readonly severity: GlobalSeverity | null
  /** Its own SLA in hours; null to take the app's SLA for the severity. */
  readonly slaHours: number | null
  /** Shown on the report screen. A disabled key sent in a report still counts as this category. */
  readonly enabled: boolean
}

export interface PolicyActionKey {
  readonly key: string
  readonly label: { readonly en: string; readonly id: string | null }
  readonly description: string | null
  /** The key that undoes this one when an appeal overturns the decision. */
  readonly reverseKey: string | null
  readonly autoAllowed: boolean
  /** `*`, global groups or global category ids: the categories that allow it. */
  readonly categories: readonly string[]
}

export interface PolicyLlmSettings {
  /** Never call the LLM: the reporter's pick, pre-rules and triage rules decide. */
  readonly rulesOnly: boolean
  /** When the LLM fails, classify by rules; when false, the case waits untriaged for a moderator. */
  readonly fallbackToRules: boolean
}

export interface Policy {
  /** The current categories in the app's order; removed ones are left out, disabled ones kept. */
  readonly categories: readonly PolicyCategory[]
  /** The current action keys in the app's order; removed ones are left out. */
  readonly actionKeys: readonly PolicyActionKey[]
  readonly llm: PolicyLlmSettings
}

export const policyCategorySchema: z.ZodType<PolicyCategory> = z.strictObject({
  key: id,
  label,
  mapsTo: z.array(z.string()),
  severity: severity.nullable(),
  slaHours: z.number().nullable(),
  enabled: z.boolean(),
})

export const policyActionKeySchema: z.ZodType<PolicyActionKey> = z.strictObject({
  key: id,
  label,
  description: z.string().nullable(),
  reverseKey: id.nullable(),
  autoAllowed: z.boolean(),
  categories: z.array(z.string()),
})

export const policyLlmSettingsSchema: z.ZodType<PolicyLlmSettings> = z.strictObject({ rulesOnly: z.boolean(), fallbackToRules: z.boolean() })

export const policySchema: z.ZodType<Policy> = z.strictObject({
  categories: z.array(policyCategorySchema),
  actionKeys: z.array(policyActionKeySchema),
  llm: policyLlmSettingsSchema,
})

/** The policy of an app that never set one: no categories, no action keys, the LLM with fallback to rules. */
export const DEFAULT_POLICY: Policy = { categories: [], actionKeys: [], llm: { rulesOnly: false, fallbackToRules: true } }

const ALL_CATEGORIES = '*'
const GROUPS = new Set(GLOBAL_CATEGORIES.map((c) => c.group))

/** True when `categories` (an action key's list) allows the global category `categoryId`. */
export function allowsCategory(categories: readonly string[], categoryId: string): boolean {
  const category = globalCategory(categoryId)
  if (!category) return false
  return categories.some((c) => c === ALL_CATEGORIES || c === category.id || c === category.group)
}

/** True when `ref` may stand in an action key's categories: `*`, a global group or a global category id. */
export function isActionKeyCategory(ref: string): boolean {
  return ref === ALL_CATEGORIES || GROUPS.has(ref) || globalCategory(ref) !== undefined
}

/**
 * The keys a decision in `categoryId` may carry, in the policy's order; null when the category is
 * not a global category.
 */
export function allowedActionKeys(policy: Policy, categoryId: string): readonly string[] | null {
  if (!globalCategory(categoryId)) return null
  return policy.actionKeys.filter((k) => allowsCategory(k.categories, categoryId)).map((k) => k.key)
}

/** The policy's current category with this key (enabled or not), or null. */
export function policyCategory(policy: Policy, key: string): PolicyCategory | null {
  return policy.categories.find((c) => c.key === key) ?? null
}

/** The app's policy in a service's copy of it: DEFAULT_POLICY until its first version reaches the copy. */
export async function policyIn<T>(copy: { get(tenant: T): Promise<{ readonly document: Policy } | null> }, tenant: T): Promise<Policy> {
  return (await copy.get(tenant))?.document ?? DEFAULT_POLICY
}
