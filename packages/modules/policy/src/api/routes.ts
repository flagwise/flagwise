// The policy routes: the action keys moderators pick from, the categories and the LLM settings,
// the report screen's menu, and what an app maps to and starts from (the global taxonomy, the presets). The edge authenticates and sets the tenant context; these
// routes authorize from it and call the use cases.

import { can, FlagwiseError, type AppAction, type TenantContext, type TenantRef } from '@flagwise/kernel'
import { GLOBAL_CATEGORIES, GLOBAL_GROUPS } from '@flagwise/contracts'
import { Hono } from 'hono'
import type { ReportScreenCategory } from '../app/policy.ts'
import { parseActionKeys, type ActionKey } from '../domain/action-keys.ts'
import { isUnmapped, parseCategories, type AppCategory, type LlmSettings } from '../domain/categories.ts'
import { PRESET_NAMES, PRESETS, type PresetName } from '../domain/presets.ts'

export interface PolicyEnv {
  Variables: { tenant: TenantContext }
}

export interface PolicyRoutesDeps {
  /** listActionKeys in a tenant transaction. */
  listActionKeys(tenant: TenantRef): Promise<readonly ActionKey[]>
  /** replaceActionKeys in a tenant transaction. */
  replaceActionKeys(tenant: TenantRef, keys: readonly ActionKey[]): Promise<readonly ActionKey[]>
  /** listCategories in a tenant transaction. */
  listCategories(tenant: TenantRef): Promise<readonly AppCategory[]>
  /** replaceCategories in a tenant transaction. */
  replaceCategories(tenant: TenantRef, categories: readonly AppCategory[]): Promise<readonly AppCategory[]>
  /** reportScreenCategories in a tenant transaction. */
  reportScreenCategories(tenant: TenantRef, locale: 'en' | 'id'): Promise<readonly ReportScreenCategory[]>
  /** getLlmSettings in a tenant transaction. */
  getLlmSettings(tenant: TenantRef): Promise<LlmSettings>
  /** setLlmSettings in a tenant transaction. */
  setLlmSettings(tenant: TenantRef, settings: LlmSettings): Promise<LlmSettings>
}

/**
 * Mounted at `/policy`; for the caller's app and mode:
 *
 * - `GET /policy/action-keys` (callers allowed `config.read`: API keys with the `admin` scope): the
 *   action keys in their order, as `{ object: 'list', data }`.
 * - `PUT /policy/action-keys` (callers allowed `integration.configure`: API keys with the `admin`
 *   scope) with `{ "data": [...] }`: replaces the whole list and answers like GET. Each key:
 *   `key`, `label: { en, id? }`, `description?`, `reverse_key?`, `auto_allowed?` (default false),
 *   `categories` (`*`, global groups or global category ids). A key left out is removed: decisions
 *   can no longer pick it, while past decisions keep it.
 * - `GET /policy/categories/definitions` (`config.read`): the categories in their order, as `{ object: 'list',
 *   data, warnings }`; `warnings` names each unmapped category, which the DSA export leaves out and
 *   metrics count as Other.
 * - `PUT /policy/categories/definitions` (callers allowed `policy.configure`: API keys with the `admin` scope)
 *   with `{ "data": [...] }` (see parseCategories) or `{ "preset": "dating" | "marketplace" |
 *   "community" }`: replaces the whole list and answers like GET. A category left out is removed:
 *   reports naming it count as an unknown pick, while past cases keep it.
 * - `GET /policy/categories/menu?locale=en|id` (`categories.read`: API keys with the `flagging`
 *   scope): the report screen's menu, the enabled categories in their order as `{ object: 'list', locale, data: [{
 *   object: 'category', key, label }] }`; default locale `en`, and an Indonesian label falls back to
 *   English.
 * - `GET /policy/llm-settings` (`config.read`): `{ object: 'llm_settings', rules_only, fallback_to_rules }`.
 * - `PUT /policy/llm-settings` (`policy.configure`) with both fields as booleans: stores them and answers like
 *   GET.
 * - `GET /policy/taxonomy` (`config.read`): the global categories `maps_to` names, the same on every
 *   install: `{ object: 'list', groups, data: [{ object: 'global_category', id, group, label,
 *   severity, p0_locked }] }`. A P0-locked category is always detected and never lowered.
 * - `GET /policy/presets` (`config.read`): what each preset holds, `{ object: 'list', data: [{
 *   object: 'preset', name, categories }] }`, each category as in the definitions.
 *
 * Field errors are 'validation_failed'; a body that is not JSON is 'invalid_request'.
 */
export function policyRoutes(deps: PolicyRoutesDeps): Hono<PolicyEnv> {
  const routes = new Hono<PolicyEnv>().basePath('/policy')

  routes.get('/action-keys', async (c) => {
    const tenant = allowed(c.get('tenant'), 'config.read')
    return c.json(listBody(await deps.listActionKeys(tenant)))
  })

  routes.put('/action-keys', async (c) => {
    const tenant = allowed(c.get('tenant'), 'integration.configure')
    const parsed = parseActionKeys((await jsonObject(c.req.text())).data)
    if (!parsed.ok) throw new FlagwiseError('validation_failed', 'The action keys are not valid', { errors: parsed.errors })
    return c.json(listBody(await deps.replaceActionKeys(tenant, parsed.keys)))
  })

  routes.get('/categories/definitions', async (c) => {
    const tenant = allowed(c.get('tenant'), 'config.read')
    return c.json(categoriesBody(await deps.listCategories(tenant)))
  })

  routes.put('/categories/definitions', async (c) => {
    const tenant = allowed(c.get('tenant'), 'policy.configure')
    const body = await jsonObject(c.req.text())
    if (body.preset !== undefined) {
      if (body.data !== undefined) throw new FlagwiseError('validation_failed', 'Give data or preset, not both', { errors: [{ path: 'preset', message: 'Give data or preset, not both' }] })
      if (!PRESET_NAMES.includes(body.preset as PresetName)) {
        throw new FlagwiseError('validation_failed', 'Unknown preset', { errors: [{ path: 'preset', message: `One of ${PRESET_NAMES.join(', ')}` }] })
      }
      return c.json(categoriesBody(await deps.replaceCategories(tenant, PRESETS[body.preset as PresetName])))
    }
    const parsed = parseCategories(body.data)
    if (!parsed.ok) throw new FlagwiseError('validation_failed', 'The categories are not valid', { errors: parsed.errors })
    return c.json(categoriesBody(await deps.replaceCategories(tenant, parsed.categories)))
  })

  routes.get('/categories/menu', async (c) => {
    const tenant = allowed(c.get('tenant'), 'categories.read')
    const locale = c.req.query('locale') ?? 'en'
    if (locale !== 'en' && locale !== 'id') throw new FlagwiseError('validation_failed', 'Unknown locale', { errors: [{ path: 'locale', message: 'en or id' }] })
    const data = await deps.reportScreenCategories(tenant, locale)
    return c.json({ object: 'list', locale, data: data.map((d) => ({ object: 'category', key: d.key, label: d.label })) })
  })

  routes.get('/llm-settings', async (c) => {
    const tenant = allowed(c.get('tenant'), 'config.read')
    return c.json(llmBody(await deps.getLlmSettings(tenant)))
  })

  routes.put('/llm-settings', async (c) => {
    const tenant = allowed(c.get('tenant'), 'policy.configure')
    const body = await jsonObject(c.req.text())
    const errors = (['rules_only', 'fallback_to_rules'] as const).filter((f) => typeof body[f] !== 'boolean').map((path) => ({ path, message: 'Must be true or false' }))
    if (errors.length) throw new FlagwiseError('validation_failed', 'The LLM settings are not valid', { errors })
    return c.json(llmBody(await deps.setLlmSettings(tenant, { rulesOnly: body.rules_only as boolean, fallbackToRules: body.fallback_to_rules as boolean })))
  })

  routes.get('/taxonomy', (c) => {
    allowed(c.get('tenant'), 'config.read')
    const data = GLOBAL_CATEGORIES.map((g) => ({ object: 'global_category', id: g.id, group: g.group, label: g.label, severity: g.severity, p0_locked: g.severity === 'P0' }))
    return c.json({ object: 'list', groups: GLOBAL_GROUPS, data })
  })

  routes.get('/presets', (c) => {
    allowed(c.get('tenant'), 'config.read')
    return c.json({ object: 'list', data: PRESET_NAMES.map((name) => ({ object: 'preset', name, categories: categoriesBody(PRESETS[name]).data })) })
  })

  return routes
}

function allowed(ctx: TenantContext, action: AppAction): TenantRef {
  if (!ctx.appId || !can(ctx, { action, appId: ctx.appId })) {
    throw new FlagwiseError('forbidden', action === 'categories.read' ? 'This API key does not have the flagging scope' : 'This API key does not have the admin scope')
  }
  return { orgId: ctx.orgId, appId: ctx.appId, livemode: ctx.livemode }
}

/** The body as a JSON object; anything else is an empty object, so its fields fail validation. */
async function jsonObject(text: Promise<string>): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = JSON.parse(await text)
  } catch {
    throw new FlagwiseError('invalid_request', 'The body is not valid JSON')
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

const categoriesBody = (categories: readonly AppCategory[]) => ({
  object: 'list',
  data: categories.map((k) => ({
    object: 'category',
    key: k.key,
    label: { en: k.label.en, id: k.label.id },
    maps_to: k.mapsTo,
    severity: k.severity,
    sla_hours: k.slaHours,
    enabled: k.enabled,
  })),
  warnings: categories.filter(isUnmapped).map((k) => ({ key: k.key, message: 'Not mapped to a global category: left out of the DSA export and counted as Other' })),
})

const llmBody = (s: LlmSettings) => ({ object: 'llm_settings', rules_only: s.rulesOnly, fallback_to_rules: s.fallbackToRules })

const listBody = (keys: readonly ActionKey[]) => ({
  object: 'list',
  data: keys.map((k) => ({
    object: 'action_key',
    key: k.key,
    label: { en: k.label.en, id: k.label.id },
    description: k.description,
    reverse_key: k.reverseKey,
    auto_allowed: k.autoAllowed,
    categories: k.categories,
  })),
})
