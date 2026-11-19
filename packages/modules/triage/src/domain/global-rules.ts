// Category rules from the global taxonomy, and from an app's own category on top of it.

import { categoriesNamed, globalCategory, OTHER_CATEGORY_ID } from '@flagwise/contracts'
import type { CategoryRule, Severity } from './triage.ts'

/**
 * The rule of a global category: the taxonomy's severity, locked when it is P0, and no suggested
 * actions. A category outside the global taxonomy (a reporter's own pick when the case was
 * classified by rules) gets the rule of `other`, so triage flags it.
 */
export function globalCategoryRule(categoryId: string): CategoryRule {
  const category = globalCategory(categoryId) ?? globalCategory(OTHER_CATEGORY_ID)!
  return { id: category.id, severity: category.severity, p0Locked: category.severity === 'P0', suggestedActionKeys: [] }
}

/** What triage needs of an app's category: its mapping and its own severity and SLA. */
export interface AppCategoryFacts {
  /** Global groups or global category ids. */
  readonly mapsTo: readonly string[]
  readonly severity: Severity | null
  readonly slaHours: number | null
}

/**
 * The rule of a case in global category `categoryId` whose app category is `app` (null when it has
 * none): the global rule (globalCategoryRule), and then
 * - with the app category's own severity: that severity, unless the global category is P0-locked;
 * - with its own SLA: that SLA, which applies while the case keeps the rule's severity;
 * - in `other` with neither, mapped to several global categories or a group (a reporter's pick
 *   classified by rules): the least severe of them, locked when that is P0. Every category the
 *   pick can mean is at least that severe.
 */
export function appCategoryRule(categoryId: string, app: AppCategoryFacts | null): CategoryRule {
  const rule = globalCategoryRule(categoryId)
  if (!app) return rule
  if (app.severity !== null || app.slaHours !== null) {
    const severity = rule.p0Locked ? 'P0' : (app.severity ?? rule.severity)
    return { ...rule, severity, ...(app.slaHours !== null && { slaHours: app.slaHours }) }
  }
  const named = categoriesNamed(app.mapsTo)
  if (rule.id !== OTHER_CATEGORY_ID || named.length === 0) return rule
  const severity = named.map((c) => c.severity).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b))
  return { ...rule, severity, p0Locked: severity === 'P0' }
}

const RANK: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2 }
