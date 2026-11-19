// Tenant identity carried by every request, job and outbox row.

/** Org-level roles cover every app in the org. */
export type OrgRole = 'owner' | 'org_admin'
/**
 * App-level roles are assigned per app; a member holds at most one per app.
 * A developer integrates the app: keys, webhooks, action keys, and full access to test-mode
 * data, but never live cases or evidence.
 */
export type AppRole = 'app_admin' | 'moderator' | 'developer'
export type Role = OrgRole | AppRole

/** Server-to-server API key scopes. */
export type ApiKeyScope = 'ingest' | 'actions' | 'admin'

/** Carried by every job and outbox row; workers run handlers under withTenant(ref, fn). */
export interface TenantRef {
  readonly orgId: string
  readonly appId: string
  readonly livemode: boolean
}

export type Actor =
  | { readonly type: 'member'; readonly id: string }
  /** An API key is bound to one app (TenantContext.appId) and carries scopes, not roles. */
  | { readonly type: 'api_key'; readonly id: string; readonly scopes: readonly ApiKeyScope[] }
  /** Tenant staff in the iframe embed; their role (moderator or app_admin) comes from the signed embed token. */
  | { readonly type: 'embed'; readonly sub: string; readonly name: string }
  | { readonly type: 'system' }

/** Built once by the edge; modules authorize locally from it. */
export interface TenantContext {
  readonly orgId: string
  /** The app of this request (API-key and embed calls); undefined for org-level dashboard calls. */
  readonly appId: string | undefined
  /** Apps this actor may read: one for API keys and embeds, the member's apps for the dashboard. */
  readonly appIds: readonly string[]
  readonly actor: Actor
  /** Owner or Org Admin of the org, if any. */
  readonly orgRole: OrgRole | null
  /** Per-app role by app id (members and embeds). */
  readonly appRoles: Readonly<Record<string, AppRole>>
  readonly livemode: boolean
}
