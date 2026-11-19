// What the policy use cases need: the stores of one app transaction, the clock and where events go.

import type { Policy } from '@flagwise/contracts'
import type { Clock, AppRef } from '@flagwise/kernel'
import type { ActionKey } from '../domain/action-keys.ts'
import type { AppCategory, LlmSettings } from '../domain/categories.ts'

/** Action keys inside one app transaction, for one app and mode. */
export interface ActionKeyStore {
  /** The app's current keys in their order; removed keys are left out. */
  list(appRef: AppRef): Promise<readonly ActionKey[]>
  /**
   * Makes `keys` the app's current keys, in this order. A key left out is kept as removed, so past
   * decisions and their reversal still find it; listing it again brings it back with the new
   * definition. Returns the current keys as they were just before.
   */
  replace(appRef: AppRef, keys: readonly ActionKey[], now: Date): Promise<readonly ActionKey[]>
}

/** Categories inside one app transaction, for one app and mode. */
export interface CategoryStore {
  /** The app's current categories in their order; removed ones are left out. */
  list(appRef: AppRef): Promise<readonly AppCategory[]>
  /**
   * Makes `categories` the app's current ones, in this order. One left out is kept as removed, so
   * past cases still find its label; listing it again brings it back with the new definition.
   * Returns the current categories as they were just before.
   */
  replace(appRef: AppRef, categories: readonly AppCategory[], now: Date): Promise<readonly AppCategory[]>
}

/** LLM settings inside one app transaction, for one app and mode. */
export interface LlmSettingsStore {
  /** The app's settings; DEFAULT_LLM_SETTINGS until they are first set. */
  get(appRef: AppRef): Promise<LlmSettings>
  /** Stores the settings; returns the ones before. */
  set(appRef: AppRef, settings: LlmSettings, now: Date): Promise<LlmSettings>
}

/** The newest version of an app's policy in one mode. */
export interface PolicyHead {
  readonly version: number
  readonly policy: Policy
}

/** The head of each app's policy, inside one app transaction. */
export interface PolicyHeadStore {
  /**
   * Locks the app's policy in this mode until the transaction ends, so changes to it take turns,
   * and answers its head; null before its first version.
   */
  lock(appRef: AppRef): Promise<PolicyHead | null>
  /** Makes `head` the app's head in this mode. */
  set(appRef: AppRef, head: PolicyHead, now: Date): Promise<void>
}

/** The policy's stores inside one app transaction. */
export interface PolicyStores {
  readonly categories: CategoryStore
  readonly actionKeys: ActionKeyStore
  readonly llm: LlmSettingsStore
  readonly heads: PolicyHeadStore
}

/** What the policy service publishes: the whole policy on every change, and what each change was. */
export type PolicyEvent =
  | { readonly type: 'policy.updated'; readonly appRef: AppRef; readonly appId: string; readonly version: number; readonly policy: Policy; readonly occurredAt: Date }
  | {
      readonly type: 'config.action_keys_replaced'
      readonly appRef: AppRef
      readonly appId: string
      readonly before: readonly ActionKey[]
      readonly after: readonly ActionKey[]
      readonly occurredAt: Date
    }
  | {
      readonly type: 'config.categories_replaced'
      readonly appRef: AppRef
      readonly appId: string
      readonly before: readonly AppCategory[]
      readonly after: readonly AppCategory[]
      readonly occurredAt: Date
    }
  | {
      readonly type: 'config.llm_settings_changed'
      readonly appRef: AppRef
      readonly appId: string
      readonly before: LlmSettings
      readonly after: LlmSettings
      readonly occurredAt: Date
    }

export interface PolicyEventPublisher {
  /** Publishes in the same transaction as the change. */
  publish(event: PolicyEvent): Promise<void>
}

export interface PolicyDeps {
  readonly stores: PolicyStores
  readonly clock: Clock
  readonly events: PolicyEventPublisher
}
