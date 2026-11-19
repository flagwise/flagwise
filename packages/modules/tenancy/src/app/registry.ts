// The tenancy registry: orgs, their apps, and the apps' API keys. Keys are managed inside a tenant
// transaction; resolving a key on an incoming request goes through the key directory, which the
// system role reads because no tenant is known until the key is resolved.

import { FlagwiseError, type ApiKeyScope, type Clock, type TenantContext, type TenantRef } from '@flagwise/kernel'
import { generateApiKey, isKeyActive, maskApiKey, normalizeScopes, parseApiKey, rotationExpiry, verifyApiKey } from '../domain/api-keys.ts'
import type { Plan } from '../domain/lifecycle.ts'

export interface Org {
  readonly id: string
  readonly name: string
  readonly plan: Plan
  readonly createdAt: Date
  readonly deletedAt: Date | null
}

export interface App {
  readonly orgId: string
  readonly id: string
  readonly name: string
  readonly createdAt: Date
  readonly deletedAt: Date | null
}

/** An API key as stored: never the key itself, only its lookup prefix and hash. */
export interface ApiKeyRecord {
  readonly orgId: string
  readonly appId: string
  readonly id: string
  readonly livemode: boolean
  readonly lookup: string
  readonly hash: string
  readonly scopes: readonly ApiKeyScope[]
  readonly createdAt: Date
  readonly expiresAt: Date | null
  readonly revokedAt: Date | null
}

/** Registry access inside one tenant transaction: every method sees only that org and its apps. */
export interface TenancyStore {
  insertOrg(org: Org): Promise<void>
  insertApp(app: App): Promise<void>
  findApp(orgId: string, appId: string): Promise<App | null>
  /** False, writing nothing, when another key already has this lookup prefix. */
  insertApiKey(key: ApiKeyRecord): Promise<boolean>
  findApiKey(orgId: string, appId: string, keyId: string): Promise<ApiKeyRecord | null>
  /**
   * Sets when the key stops working, only if it is still active at `now` and the new end is
   * earlier than any it already has; true when it changed.
   */
  endApiKey(orgId: string, appId: string, keyId: string, end: { revokedAt: Date } | { expiresAt: Date }, now: Date): Promise<boolean>
}

/** What resolving a key needs: the key, and whether its app and org are deleted. */
export interface DirectoryEntry {
  readonly key: ApiKeyRecord
  readonly appDeletedAt: Date | null
  readonly orgDeletedAt: Date | null
}

/** Read by the system role: finds a key by its lookup prefix across every tenant. */
export interface KeyDirectory {
  findByLookup(lookup: string): Promise<DirectoryEntry | null>
}

/** The app and mode a key belongs to. */
const refOf = (k: ApiKeyRecord): TenantRef => ({ orgId: k.orgId, appId: k.appId, livemode: k.livemode })

/** The key's lifetime in the form isKeyActive takes. */
const lifetime = (k: ApiKeyRecord) => ({ createdAt: k.createdAt, revokedAt: k.revokedAt ?? undefined, expiresAt: k.expiresAt ?? undefined })

/** What tenancy publishes when a key changes; ids and scopes only, never a key. */
export type TenancyEvent =
  | { readonly type: 'api_key.issued'; readonly tenant: TenantRef; readonly keyId: string; readonly scopes: readonly ApiKeyScope[]; readonly occurredAt: Date }
  | { readonly type: 'api_key.rotated'; readonly tenant: TenantRef; readonly keyId: string; readonly replacedBy: string; readonly expiresAt: Date; readonly occurredAt: Date }
  | { readonly type: 'api_key.revoked'; readonly tenant: TenantRef; readonly keyId: string; readonly occurredAt: Date }

export interface TenancyEventPublisher {
  /** Publishes in the same transaction as the change. */
  publish(event: TenancyEvent): Promise<void>
}

export interface RegistryDeps {
  readonly store: TenancyStore
  readonly clock: Clock
  readonly newId: (prefix: 'org' | 'app' | 'key') => string
  /** Where key changes are published (for the audit log); left out, nothing is. */
  readonly events?: TenancyEventPublisher
}

/** Creates an org on the given plan (free by default). */
export async function createOrg(deps: RegistryDeps, input: { readonly id?: string; readonly name: string; readonly plan?: Plan }): Promise<Org> {
  const name = input.name.trim()
  if (!name) throw new FlagwiseError('invalid_request', 'An org needs a name')
  const org: Org = { id: input.id ?? deps.newId('org'), name, plan: input.plan ?? 'free', createdAt: deps.clock.now(), deletedAt: null }
  await deps.store.insertOrg(org)
  return org
}

/** Creates an app in the org. */
export async function createApp(deps: RegistryDeps, input: { readonly orgId: string; readonly id?: string; readonly name: string }): Promise<App> {
  const name = input.name.trim()
  if (!name) throw new FlagwiseError('invalid_request', 'An app needs a name')
  const app: App = { orgId: input.orgId, id: input.id ?? deps.newId('app'), name, createdAt: deps.clock.now(), deletedAt: null }
  await deps.store.insertApp(app)
  return app
}

export interface IssuedApiKey {
  /** The key itself: shown once, never stored. */
  readonly key: string
  readonly masked: string
  readonly record: ApiKeyRecord
}

/**
 * Issues a key for an app and mode with the given scopes (deduplicated and ordered). The key is
 * returned once and only its hash is stored. 'invalid_request' for unknown or no scopes;
 * 'not_found' for an app that does not exist or is deleted.
 */
export async function issueApiKey(
  deps: RegistryDeps,
  input: { readonly orgId: string; readonly appId: string; readonly livemode: boolean; readonly scopes: readonly string[] },
): Promise<IssuedApiKey> {
  const scopes = normalizeScopes(input.scopes)
  if (!scopes) throw new FlagwiseError('invalid_request', 'Scopes must be one or more of flagging, actions, admin')
  const app = await deps.store.findApp(input.orgId, input.appId)
  if (!app || app.deletedAt) throw new FlagwiseError('not_found', `No app ${input.appId}`)
  const now = deps.clock.now()
  // A clash of the 12-character lookup prefix (about 1 in 3 * 10^21) only costs a new key.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const generated = generateApiKey(input.livemode)
    const record: ApiKeyRecord = {
      orgId: input.orgId,
      appId: input.appId,
      id: deps.newId('key'),
      livemode: input.livemode,
      lookup: generated.lookup,
      hash: generated.hash,
      scopes,
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
    }
    if (await deps.store.insertApiKey(record)) {
      await deps.events?.publish({ type: 'api_key.issued', tenant: refOf(record), keyId: record.id, scopes, occurredAt: now })
      return { key: generated.key, masked: maskApiKey(generated.key), record }
    }
  }
  throw new Error('Could not find a free API key prefix')
}

/**
 * Rotates a key: issues a new one with the same app, mode and scopes, and lets the old one work
 * for `overlapMs` more (1 hour to 7 days, else RangeError). 'not_found' when the key does not
 * exist or no longer works.
 */
export async function rotateApiKey(
  deps: RegistryDeps,
  input: { readonly orgId: string; readonly appId: string; readonly keyId: string; readonly overlapMs: number },
): Promise<IssuedApiKey> {
  const now = deps.clock.now()
  const expiresAt = rotationExpiry(now, input.overlapMs)
  const old = await deps.store.findApiKey(input.orgId, input.appId, input.keyId)
  if (!old || !isKeyActive(lifetime(old), now)) throw new FlagwiseError('not_found', `No active API key ${input.keyId}`)
  const issued = await issueApiKey(deps, { orgId: old.orgId, appId: old.appId, livemode: old.livemode, scopes: old.scopes })
  if (await deps.store.endApiKey(old.orgId, old.appId, old.id, { expiresAt }, now)) {
    await deps.events?.publish({ type: 'api_key.rotated', tenant: refOf(old), keyId: old.id, replacedBy: issued.record.id, expiresAt, occurredAt: now })
  }
  return issued
}

/** Revokes a key at once. 'not_found' when the key does not exist; revoking an ended key changes nothing. */
export async function revokeApiKey(deps: RegistryDeps, input: { readonly orgId: string; readonly appId: string; readonly keyId: string }): Promise<void> {
  const now = deps.clock.now()
  const key = await deps.store.findApiKey(input.orgId, input.appId, input.keyId)
  if (!key) throw new FlagwiseError('not_found', `No API key ${input.keyId}`)
  if (await deps.store.endApiKey(input.orgId, input.appId, input.keyId, { revokedAt: now }, now)) {
    await deps.events?.publish({ type: 'api_key.revoked', tenant: refOf(key), keyId: key.id, occurredAt: now })
  }
}

export type KeyResolution =
  | { readonly ok: true; readonly context: TenantContext }
  /**
   * Why the key does not let the request in. 'app_deleted': the key is valid but its app (or org)
   * is deleted, which flagging answers with 410; every other reason is a 401.
   */
  | { readonly ok: false; readonly reason: 'malformed' | 'unknown' | 'inactive' | 'app_deleted' }

/**
 * Resolves the bearer key of a request to its tenant: the key's org, its one app, its mode and an
 * API-key actor with the key's scopes. A key whose hash does not match is 'unknown', the same as a
 * key that does not exist, so a caller cannot tell a guessed prefix from a real one.
 */
export async function resolveApiKey(directory: KeyDirectory, key: string, now: Date): Promise<KeyResolution> {
  const parsed = parseApiKey(key)
  if (!parsed) return { ok: false, reason: 'malformed' }
  const entry = await directory.findByLookup(parsed.lookup)
  if (!entry || !verifyApiKey(key, entry.key.hash) || entry.key.livemode !== parsed.livemode) return { ok: false, reason: 'unknown' }
  if (entry.appDeletedAt || entry.orgDeletedAt) return { ok: false, reason: 'app_deleted' }
  if (!isKeyActive(lifetime(entry.key), now)) return { ok: false, reason: 'inactive' }
  const k = entry.key
  return {
    ok: true,
    context: {
      orgId: k.orgId,
      appId: k.appId,
      appIds: [k.appId],
      actor: { type: 'api_key', id: k.id, scopes: k.scopes },
      orgRole: null,
      appRoles: {},
      livemode: k.livemode,
    },
  }
}
