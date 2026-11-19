// An app's policy per mode: its categories, action keys and LLM settings, each replaced as a whole.
// Every change that leaves the policy different makes a new version, one integer per app and mode
// counting from 1, and publishes `policy.updated` with the whole policy, so every service that
// reads it keeps its own copy. The change, the new head and the events commit together.

import { DEFAULT_POLICY, type Policy } from '@flagwise/contracts'
import type { TenantRef } from '@flagwise/kernel'
import type { ActionKey } from '../domain/action-keys.ts'
import type { AppCategory, LlmSettings } from '../domain/categories.ts'
import type { PolicyDeps, PolicyHead, PolicyStores } from './ports.ts'

/** The app's whole policy in this mode, as it stands in the transaction. */
export async function currentPolicy(stores: PolicyStores, tenant: TenantRef): Promise<Policy> {
  // One after another: the stores share the transaction's connection.
  const categories = await stores.categories.list(tenant)
  const actionKeys = await stores.actionKeys.list(tenant)
  const llm = await stores.llm.get(tenant)
  return { categories, actionKeys, llm: { rulesOnly: llm.rulesOnly, fallbackToRules: llm.fallbackToRules } }
}

/**
 * Runs `change` with the app's policy locked, then, when the policy is no longer what its head says
 * (DEFAULT_POLICY before the first version), stores the next version as the head and publishes
 * `policy.updated`. A change that leaves the policy as it was makes no version.
 */
async function changePolicy<R>(deps: PolicyDeps, tenant: TenantRef, change: (now: Date) => Promise<R>): Promise<R> {
  const now = deps.clock.now()
  const head = await deps.stores.heads.lock(tenant)
  const result = await change(now)
  const policy = await currentPolicy(deps.stores, tenant)
  if (canonical(policy) !== canonical(head?.policy ?? DEFAULT_POLICY)) {
    const next: PolicyHead = { version: (head?.version ?? 0) + 1, policy }
    await deps.stores.heads.set(tenant, next, now)
    await deps.events.publish({ type: 'policy.updated', tenant, appId: tenant.appId, version: next.version, policy, occurredAt: now })
  }
  return result
}

/** The app's action keys in their order. */
export function listActionKeys(stores: Pick<PolicyStores, 'actionKeys'>, tenant: TenantRef): Promise<readonly ActionKey[]> {
  return stores.actionKeys.list(tenant)
}

/**
 * Replaces the app's action keys (checked by parseActionKeys) and returns them. Publishes
 * `config.action_keys_replaced` with the list before and after, and `policy.updated`, unless
 * nothing changed.
 */
export function replaceActionKeys(deps: PolicyDeps, tenant: TenantRef, keys: readonly ActionKey[]): Promise<readonly ActionKey[]> {
  return changePolicy(deps, tenant, async (now) => {
    const before = await deps.stores.actionKeys.replace(tenant, keys, now)
    const after = await deps.stores.actionKeys.list(tenant)
    if (canonical(before) !== canonical(after)) {
      await deps.events.publish({ type: 'config.action_keys_replaced', tenant, appId: tenant.appId, before, after, occurredAt: now })
    }
    return after
  })
}

/** The app's categories in their order. */
export function listCategories(stores: Pick<PolicyStores, 'categories'>, tenant: TenantRef): Promise<readonly AppCategory[]> {
  return stores.categories.list(tenant)
}

/**
 * Replaces the app's categories (checked by parseCategories, or a preset) and returns them.
 * Publishes `config.categories_replaced` with the list before and after, and `policy.updated`,
 * unless nothing changed.
 */
export function replaceCategories(deps: PolicyDeps, tenant: TenantRef, categories: readonly AppCategory[]): Promise<readonly AppCategory[]> {
  return changePolicy(deps, tenant, async (now) => {
    const before = await deps.stores.categories.replace(tenant, categories, now)
    const after = await deps.stores.categories.list(tenant)
    if (canonical(before) !== canonical(after)) {
      await deps.events.publish({ type: 'config.categories_replaced', tenant, appId: tenant.appId, before, after, occurredAt: now })
    }
    return after
  })
}

/** A report screen entry: the key to send as a report's `category`, and its label in one language. */
export interface ReportScreenCategory {
  readonly key: string
  readonly label: string
}

/**
 * The enabled categories in their order, labelled in `locale` ('en' or 'id'); a category without an
 * Indonesian label falls back to English.
 */
export async function reportScreenCategories(stores: Pick<PolicyStores, 'categories'>, tenant: TenantRef, locale: 'en' | 'id'): Promise<readonly ReportScreenCategory[]> {
  return (await stores.categories.list(tenant)).filter((c) => c.enabled).map((c) => ({ key: c.key, label: (locale === 'id' ? c.label.id : null) ?? c.label.en }))
}

/** The app's LLM settings. */
export function getLlmSettings(stores: Pick<PolicyStores, 'llm'>, tenant: TenantRef): Promise<LlmSettings> {
  return stores.llm.get(tenant)
}

/**
 * Stores the app's LLM settings and returns them; publishes `config.llm_settings_changed` and
 * `policy.updated` when they changed.
 */
export function setLlmSettings(deps: PolicyDeps, tenant: TenantRef, settings: LlmSettings): Promise<LlmSettings> {
  return changePolicy(deps, tenant, async (now) => {
    const before = await deps.stores.llm.set(tenant, settings, now)
    const after = { rulesOnly: settings.rulesOnly, fallbackToRules: settings.fallbackToRules }
    if (before.rulesOnly !== after.rulesOnly || before.fallbackToRules !== after.fallbackToRules) {
      await deps.events.publish({ type: 'config.llm_settings_changed', tenant, appId: tenant.appId, before, after, occurredAt: now })
    }
    return after
  })
}

/** JSON with object keys sorted, so a policy read back from storage compares equal to one built here. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  )
}
