// Where a notification to members goes: the app's route for its type, or the default one, within
// the channels the plan allows.

export type AlertType =
  | 'new_p0'
  | 'sla_75'
  | 'sla_breach'
  | 'appeal_received'
  | 'appeal_sla_75'
  | 'appeal_sla_breach'
  | 'credits_low'
  | 'webhook_failing'
  | 'action_overdue'

export type Channel = 'email' | 'slack' | 'discord'
export type AlertRole = 'owner' | 'admin' | 'app_admin' | 'moderator' | 'developer'

const CHANNEL_ORDER: readonly Channel[] = ['email', 'slack', 'discord']
const ROLE_ORDER: readonly AlertRole[] = ['owner', 'admin', 'app_admin', 'moderator', 'developer']
const DEFAULT_CHANNELS: readonly Channel[] = ['email']
const DEFAULT_ROLES: readonly AlertRole[] = ['owner', 'admin', 'app_admin']

export interface AlertRoute {
  readonly channels: readonly Channel[]
  readonly roles: readonly AlertRole[]
}

export interface RoutedAlert {
  readonly channels: readonly Channel[]
  readonly roles: readonly AlertRole[]
  readonly dropped: readonly Channel[]
}

/**
 * Where an alert goes. The route is `routes[type]` when the app configured one, else email to
 * Owner, Admin and App Admin (plus Moderator for new_p0 and sla_breach). Free allows email only;
 * Pro allows email, Slack and Discord; the rest go to `dropped`. With no allowed channel left,
 * channels is ['email']. All lists are deduplicated in canonical order: email, slack, discord;
 * owner, admin, app_admin, moderator, developer.
 */
export function routeAlert(
  type: AlertType,
  plan: 'free' | 'pro',
  routes?: Readonly<Partial<Record<AlertType, AlertRoute>>>,
): RoutedAlert {
  const route = routes?.[type]
  const wantedChannels = route ? route.channels : DEFAULT_CHANNELS
  const wantedRoles = route ? route.roles : type === 'new_p0' || type === 'sla_breach' ? [...DEFAULT_ROLES, 'moderator' as const] : DEFAULT_ROLES
  const allowed = plan === 'pro' ? CHANNEL_ORDER : CHANNEL_ORDER.filter((c) => c === 'email')
  const channels = allowed.filter((c) => wantedChannels.includes(c))
  const dropped = CHANNEL_ORDER.filter((c) => wantedChannels.includes(c) && !allowed.includes(c))
  return {
    channels: channels.length > 0 ? channels : ['email'],
    roles: ROLE_ORDER.filter((r) => wantedRoles.includes(r)),
    dropped,
  }
}
