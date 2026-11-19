import { DEFAULT_POLICY } from '@flagwise/contracts'
import { manualClock, type TenantRef } from '@flagwise/kernel'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LLM_SETTINGS,
  parseActionKeys,
  PRESETS,
  replaceActionKeys,
  replaceCategories,
  reportScreenCategories,
  setLlmSettings,
  type ActionKey,
  type AppCategory,
  type LlmSettings,
  type PolicyEvent,
  type PolicyHead,
  type PolicyStores,
} from '../src/index.ts'

const A: TenantRef = { orgId: 'org_jane', appId: 'app_a', livemode: true }
const NOW = new Date('2026-11-18T09:00:00Z')

function memoryStores(): PolicyStores & { head: PolicyHead | null; categoryList: AppCategory[] } {
  let keys: readonly ActionKey[] = []
  let llm: LlmSettings = DEFAULT_LLM_SETTINGS
  const s = {
    head: null as PolicyHead | null,
    categoryList: [] as AppCategory[],
    categories: {
      list: async () => s.categoryList,
      replace: async (_t: TenantRef, next: readonly AppCategory[]) => {
        const before = s.categoryList
        s.categoryList = [...next]
        return before
      },
    },
    actionKeys: {
      list: async () => keys,
      replace: async (_t: TenantRef, next: readonly ActionKey[]) => {
        const before = keys
        keys = next
        return before
      },
    },
    llm: {
      get: async () => llm,
      set: async (_t: TenantRef, next: LlmSettings) => {
        const before = llm
        llm = next
        return before
      },
    },
    heads: {
      // Storage hands the policy back with its keys in another order, as jsonb does.
      lock: async () => (s.head ? { version: s.head.version, policy: reorder(s.head) } : null),
      set: async (_t: TenantRef, head: PolicyHead) => void (s.head = head),
    },
  }
  return s
}

/** The head with every object's keys reversed. */
const reorder = (head: PolicyHead) => JSON.parse(JSON.stringify(head.policy), (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))

const setup = () => {
  const stores = memoryStores()
  const events: PolicyEvent[] = []
  const deps = { stores, clock: manualClock(NOW), events: { publish: async (e: PolicyEvent) => void events.push(e) } }
  const updates = () => events.filter((e) => e.type === 'policy.updated')
  return { stores, events, deps, updates }
}

const keysOf = (input: unknown[]): readonly ActionKey[] => {
  const parsed = parseActionKeys(input)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return parsed.keys
}

describe('policy versions', () => {
  it('publishes the whole policy as version 1 on the first change, then counts up per change', async () => {
    const { deps, updates } = setup()
    await replaceCategories(deps, A, PRESETS.dating)
    expect(updates()).toEqual([{ type: 'policy.updated', tenant: A, appId: 'app_a', version: 1, policy: { ...DEFAULT_POLICY, categories: PRESETS.dating }, occurredAt: NOW }])
    const keys = keysOf([{ key: 'warn', label: { en: 'Warn' }, categories: ['*'] }])
    await replaceActionKeys(deps, A, keys)
    await setLlmSettings(deps, A, { rulesOnly: true, fallbackToRules: false })
    expect(updates().map((e) => e.type === 'policy.updated' && e.version)).toEqual([1, 2, 3])
    expect(updates().at(-1)).toMatchObject({ version: 3, policy: { categories: PRESETS.dating, actionKeys: keys, llm: { rulesOnly: true, fallbackToRules: false } } })
  })

  it('makes no version for a save that leaves the policy as it is, though storage orders its keys differently', async () => {
    const { deps, stores, updates } = setup()
    await setLlmSettings(deps, A, DEFAULT_LLM_SETTINGS)
    await replaceCategories(deps, A, [])
    expect(updates()).toEqual([])
    expect(stores.head).toBeNull()
    await replaceCategories(deps, A, PRESETS.marketplace)
    await replaceCategories(deps, A, PRESETS.marketplace)
    expect(updates()).toHaveLength(1)
    expect(stores.head?.version).toBe(1)
  })

  it('counts a change back to the defaults as a version too', async () => {
    const { deps, updates } = setup()
    await setLlmSettings(deps, A, { rulesOnly: true, fallbackToRules: true })
    await setLlmSettings(deps, A, DEFAULT_LLM_SETTINGS)
    expect(updates().map((e) => e.type === 'policy.updated' && [e.version, e.policy])).toEqual([
      [1, { ...DEFAULT_POLICY, llm: { rulesOnly: true, fallbackToRules: true } }],
      [2, DEFAULT_POLICY],
    ])
  })
})

describe('replaceCategories and the report screen', () => {
  it('publishes the change once, with before and after', async () => {
    const { deps, events } = setup()
    expect(await replaceCategories(deps, A, PRESETS.dating)).toEqual(PRESETS.dating)
    await replaceCategories(deps, A, PRESETS.dating)
    expect(events.filter((e) => e.type === 'config.categories_replaced')).toEqual([{ type: 'config.categories_replaced', tenant: A, appId: 'app_a', before: [], after: PRESETS.dating, occurredAt: NOW }])
  })

  it('lists the enabled ones, labelled in the locale with English as fallback', async () => {
    const { stores } = setup()
    stores.categoryList = [
      { ...PRESETS.dating[0]!, label: { en: 'Fake profile', id: 'Profil palsu' } },
      { ...PRESETS.dating[1]!, enabled: false },
      { ...PRESETS.dating[2]!, label: { en: 'Rude or harassing', id: null } },
    ]
    expect(await reportScreenCategories(stores, A, 'id')).toEqual([
      { key: 'fake_profile', label: 'Profil palsu' },
      { key: 'rude_or_harassing', label: 'Rude or harassing' },
    ])
  })
})

describe('setLlmSettings', () => {
  it('stores the settings and publishes only a change', async () => {
    const { deps, events } = setup()
    expect(await setLlmSettings(deps, A, { rulesOnly: false, fallbackToRules: true })).toEqual(DEFAULT_LLM_SETTINGS)
    expect(events).toEqual([])
    await setLlmSettings(deps, A, { rulesOnly: true, fallbackToRules: true })
    expect(events.filter((e) => e.type === 'config.llm_settings_changed')).toEqual([
      { type: 'config.llm_settings_changed', tenant: A, appId: 'app_a', before: DEFAULT_LLM_SETTINGS, after: { rulesOnly: true, fallbackToRules: true }, occurredAt: NOW },
    ])
  })
})
