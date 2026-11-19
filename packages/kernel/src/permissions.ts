// Role permissions: a pure function over a static role matrix. Rules that depend on data (case
// claims, "an appeal is reviewed by a different member", a legal hold blocking erasure) are checked
// in the module that owns that data.

import type { ApiKeyScope, AppRole, AdminRole, Role, TenantContext } from './tenant.ts'

/** Actions over every app; dashboard members with an admin role only. */
export type AdminAction =
  | 'billing.manage' // plan, credits, top-up, payment portal
  | 'app.create'
  | 'app.delete'
  | 'member.remove'
  | 'ownership.transfer'

/** Actions on one app. */
export type AppAction =
  | 'config.read' // categories, action keys, thresholds, SLA, notices, LLM settings; never secrets
  | 'integration.configure' // webhook endpoints, action keys, webhook test and redelivery
  | 'policy.configure' // categories, severity, SLA, thresholds, notices, branding, LLM settings
  | 'api_key.manage' // API keys, webhook and embed secrets
  | 'case.work' // claim, release, change category or severity, decide, feedback
  | 'account.read' // score, ledger, past cases and decisions of an account
  | 'score.adjust'
  | 'appeal.review'
  | 'legal_hold.manage'
  | 'evidence.export'
  | 'subject.erase' // start an erasure, read its progress
  | 'support_bundle.send'
  | 'audit.read'
  | 'metrics.read'
  | 'categories.read' // report-screen labels
  // Tenant backend calls (API keys only)
  | 'report.create'
  | 'identifiers.check'
  | 'action_request.respond'
  | 'appeal.file'

/** Giving someone a role: inviting them, or changing their role. */
export type GrantAction = 'member.invite' | 'role.assign'

export type Permission =
  | { readonly action: AdminAction }
  | { readonly action: AppAction; readonly appId: string }
  | { readonly action: GrantAction; readonly role: Role; readonly appId?: string }
  /** Full evidence of another app's history on a cross-app identifier match. */
  | { readonly action: 'evidence.cross_app_full'; readonly appId: string; readonly otherAppId: string }

const ADMIN_ACTIONS: Readonly<Record<AdminAction, readonly AdminRole[]>> = {
  'billing.manage': ['owner'],
  'app.create': ['owner', 'admin'],
  'app.delete': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],
  'ownership.transfer': ['owner'],
}

/** `always`: live and test mode; `test`: test-mode requests only. */
type Access = 'always' | 'test'

interface AppRule {
  /** App roles allowed; Owner and Admin hold every app action that members may use. */
  readonly roles: Readonly<Partial<Record<AppRole, Access>>>
  /** API key scope that allows it; null means dashboard only. */
  readonly scope: ApiKeyScope | null
  /** Only API keys may call it (tenant backend calls). */
  readonly apiOnly?: true
}

const ALL: Readonly<Partial<Record<AppRole, Access>>> = { app_admin: 'always', moderator: 'always', developer: 'always' }
/** Case work: App Admin and Moderator; developers only on test data. */
const CASES: Readonly<Partial<Record<AppRole, Access>>> = { app_admin: 'always', moderator: 'always', developer: 'test' }
/** Irreversible or data-heavy: App Admin; developers only on test data. */
const ADMIN: Readonly<Partial<Record<AppRole, Access>>> = { app_admin: 'always', developer: 'test' }
/** Integration: App Admin and Developer. */
const INTEGRATION: Readonly<Partial<Record<AppRole, Access>>> = { app_admin: 'always', developer: 'always' }

const APP_ACTIONS: Readonly<Record<AppAction, AppRule>> = {
  'config.read': { roles: ALL, scope: 'admin' },
  'integration.configure': { roles: INTEGRATION, scope: 'admin' },
  'policy.configure': { roles: { app_admin: 'always' }, scope: 'admin' },
  'api_key.manage': { roles: INTEGRATION, scope: null },
  'case.work': { roles: CASES, scope: 'admin' },
  'account.read': { roles: CASES, scope: 'admin' },
  'score.adjust': { roles: CASES, scope: 'admin' },
  'appeal.review': { roles: CASES, scope: 'admin' },
  'legal_hold.manage': { roles: ADMIN, scope: 'admin' },
  'evidence.export': { roles: ADMIN, scope: 'admin' },
  'subject.erase': { roles: ADMIN, scope: 'admin' },
  'support_bundle.send': { roles: CASES, scope: null },
  'audit.read': { roles: CASES, scope: 'admin' },
  'metrics.read': { roles: ALL, scope: 'admin' },
  'categories.read': { roles: ALL, scope: 'flagging' },
  'report.create': { roles: {}, scope: 'flagging', apiOnly: true },
  'identifiers.check': { roles: {}, scope: 'flagging', apiOnly: true },
  'action_request.respond': { roles: {}, scope: 'actions', apiOnly: true },
  'appeal.file': { roles: {}, scope: 'actions', apiOnly: true },
}

/** Roles an iframe-embed token may carry. */
const EMBED_ROLES: ReadonlySet<AppRole> = new Set(['moderator', 'app_admin'])
/**
 * Anyone holding the embed secret can mint a session, so embedded staff never touch keys,
 * secrets or where webhooks go.
 */
const EMBED_DENIED: ReadonlySet<AppAction> = new Set(['api_key.manage', 'integration.configure'])

/** App roles that see live evidence, which cross-app evidence access requires. */
const EVIDENCE_ROLES: ReadonlySet<AppRole> = new Set(['app_admin', 'moderator'])

const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin'])

/**
 * Whether the actor in `ctx` may perform `permission`.
 *
 * - Owner and Admin may do every admin action listed for them and every app action members may
 *   use, in every app they may read.
 * - App Admin, Moderator and Developer act per app, by the matrix above; a Developer reaches cases,
 *   accounts, evidence and the audit log only in test mode.
 * - API keys act by scope, on their own app only, and never manage keys, roles or settings across apps.
 *   Tenant backend calls (report.create, identifiers.check, action_request.respond, appeal.file)
 *   are API-key only.
 * - Embedded staff get their token's role in the embedded app only, never keys or webhook
 *   destinations.
 * - The system actor is always denied: background jobs do not authorize through can().
 */
export function can(ctx: TenantContext, permission: Permission): boolean {
  const { actor } = ctx
  if (actor.type === 'system') return false

  if (actor.type === 'api_key') {
    if (!isAppAction(permission)) return false
    const rule = APP_ACTIONS[permission.action]
    return permission.appId === ctx.appId && rule.scope !== null && actor.scopes.includes(rule.scope)
  }

  switch (permission.action) {
    case 'evidence.cross_app_full':
      return hasEvidenceAccess(ctx, permission.appId) && hasEvidenceAccess(ctx, permission.otherAppId)

    case 'member.invite':
    case 'role.assign':
      return actor.type === 'member' && canGrant(ctx, permission.role, permission.appId)

    default: {
      if (!isAppAction(permission)) {
        return actor.type === 'member' && ctx.adminRole !== null && ADMIN_ACTIONS[permission.action].includes(ctx.adminRole)
      }
      const rule = APP_ACTIONS[permission.action]
      if (rule.apiOnly) return false
      const role = ctx.appRoles[permission.appId]
      if (actor.type === 'embed') {
        if (permission.appId !== ctx.appId || role === undefined || !EMBED_ROLES.has(role)) return false
        if (EMBED_DENIED.has(permission.action)) return false
      }
      if (ctx.adminRole !== null) return true
      if (role === undefined) return false
      const access = rule.roles[role]
      return access === 'always' || (access === 'test' && !ctx.livemode)
    }
  }
}

function isAppAction(p: Permission): p is Extract<Permission, { action: AppAction }> {
  return Object.hasOwn(APP_ACTIONS, p.action)
}

function hasEvidenceAccess(ctx: TenantContext, appId: string): boolean {
  if (ctx.adminRole !== null) return true
  const role = ctx.appRoles[appId]
  return role !== undefined && EVIDENCE_ROLES.has(role)
}

/**
 * Owner is never granted (ownership only moves by transfer); Owner and Admin grant any other
 * role; an App Admin grants Moderator or Developer in their own app.
 */
function canGrant(ctx: TenantContext, role: Role, appId: string | undefined): boolean {
  if (role === 'owner') return false
  const isAdminRole = ADMIN_ROLES.has(role)
  if (isAdminRole === (appId !== undefined)) return false
  if (ctx.adminRole !== null) return true
  return (role === 'moderator' || role === 'developer') && appId !== undefined && ctx.appRoles[appId] === 'app_admin'
}
