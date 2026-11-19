// Who a request is from and which apps and mode it may reach (Caller), and the one app
// and mode of every job and event (AppRef).

/** Admin roles cover every app the actor may read (Caller.appIds). */
export type AdminRole = 'owner' | 'admin'
/**
 * App-level roles are assigned per app; a member holds at most one per app.
 * A developer integrates the app: keys, webhooks, action keys, and full access to test-mode
 * data, but never live cases or evidence.
 */
export type AppRole = 'app_admin' | 'moderator' | 'developer'
export type Role = AdminRole | AppRole

/** Server-to-server API key scopes. */
export type ApiKeyScope = 'flagging' | 'actions' | 'admin'

/** Carried by every job and outbox row; workers run handlers under withApps(ref, fn). */
export interface AppRef {
  readonly appId: string
  readonly livemode: boolean
}

export type Actor =
  | { readonly type: 'member'; readonly id: string }
  /** An API key is bound to one app (Caller.appId) and carries scopes, not roles. */
  | { readonly type: 'api_key'; readonly id: string; readonly scopes: readonly ApiKeyScope[] }
  /** Tenant staff in the iframe embed; their role (moderator or app_admin) comes from the signed embed token. */
  | { readonly type: 'embed'; readonly sub: string; readonly name: string }
  | { readonly type: 'system' }

/** Who is calling and what they may reach: built once by the edge; modules authorize locally from it. */
export interface Caller {
  /** The app of this request (API-key and embed calls); undefined for dashboard calls across apps. */
  readonly appId: string | undefined
  /** Apps this actor may read: one for API keys and embeds, the member's apps for the dashboard. */
  readonly appIds: readonly string[]
  readonly actor: Actor
  /** Owner or Admin over every app in appIds, if any. */
  readonly adminRole: AdminRole | null
  /** Per-app role by app id (members and embeds). */
  readonly appRoles: Readonly<Record<string, AppRole>>
  readonly livemode: boolean
}
