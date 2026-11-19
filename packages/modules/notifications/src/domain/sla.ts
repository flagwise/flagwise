// SLA timers and alerts. The SLA is the tenant team's internal target. A Timer runs from startedAt
// to dueAt (dueAt must be after startedAt, else RangeError) and stops at stoppedAt: a case's clock
// stops at its first decision, an appeal's when it is resolved.

export type Severity = 'P0' | 'P1' | 'P2'

export interface Timer {
  readonly kind: 'case' | 'appeal'
  readonly id: string
  readonly severity?: Severity
  readonly startedAt: Date
  readonly dueAt: Date
  readonly stoppedAt: Date | null
}

export interface SlaStatus {
  readonly state: 'running' | 'breached' | 'met' | 'missed'
  readonly elapsedRatio: number
  readonly remainingMs: number
}

export type AlertType =
  | 'new_p0'
  | 'sla_75'
  | 'sla_breach'
  | 'appeal_received'
  | 'appeal_sla_75'
  | 'appeal_sla_breach'
  | 'credits_low'
  | 'webhook_failing'

export interface DueAlert {
  readonly type: AlertType
  readonly key: string
  readonly at: Date
}

export type Channel = 'email' | 'slack' | 'discord'
export type AlertRole = 'owner' | 'admin' | 'app_admin' | 'moderator' | 'developer'

const CHANNEL_ORDER: readonly Channel[] = ['email', 'slack', 'discord']
const ROLE_ORDER: readonly AlertRole[] = ['owner', 'admin', 'app_admin', 'moderator', 'developer']
const DEFAULT_CHANNELS: readonly Channel[] = ['email']
const DEFAULT_ROLES: readonly AlertRole[] = ['owner', 'admin', 'app_admin']

function checkTimer(timer: Timer): void {
  if (timer.dueAt.getTime() <= timer.startedAt.getTime()) throw new RangeError('dueAt must be after startedAt')
}

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
 * Where a timer stands. Stopped (`stoppedAt <= now`): 'met' when stopped by dueAt, else 'missed',
 * measured at stoppedAt. Otherwise 'running' while now < dueAt, then 'breached', measured at now.
 * `elapsedRatio = (measured - startedAt) / (dueAt - startedAt)`, never below 0;
 * `remainingMs = dueAt - measured` (negative once late).
 */
export function slaStatus(timer: Timer, now: Date): SlaStatus {
  checkTimer(timer)
  const stopped = timer.stoppedAt !== null && timer.stoppedAt.getTime() <= now.getTime()
  const measured = stopped ? timer.stoppedAt!.getTime() : now.getTime()
  const due = timer.dueAt.getTime()
  const start = timer.startedAt.getTime()
  const state = stopped ? (measured <= due ? 'met' : 'missed') : measured < due ? 'running' : 'breached'
  return { state, elapsedRatio: Math.max(0, (measured - start) / (due - start)), remainingMs: due - measured }
}

/**
 * The alerts due now that were not sent yet, ordered by `at` then by the order below;
 * `key = ${kind}:${id}:${type}` and keys in `sentKeys` are skipped.
 *
 * - Case timers: new_p0 at startedAt, only for severity P0 (it fires even if the case was decided
 *   since); sla_75 at the 75% point; sla_breach at dueAt.
 * - Appeal timers: appeal_received at startedAt; appeal_sla_75; appeal_sla_breach at dueAt.
 *
 * The 75% point is `startedAt + floor((dueAt - startedAt) * 3 / 4)` ms. An alert is due when
 * `now >= at`; the 75% and breach alerts are not due when the timer stopped at or before their `at`.
 */
export function timerAlerts(timer: Timer, sentKeys: ReadonlySet<string>, now: Date): DueAlert[] {
  checkTimer(timer)
  const start = timer.startedAt.getTime()
  const due = timer.dueAt.getTime()
  const stop = timer.stoppedAt ? timer.stoppedAt.getTime() : Infinity
  const prefix = timer.kind === 'case' ? '' : 'appeal_'
  const candidates: { type: AlertType; at: number }[] = []
  if (timer.kind === 'case') {
    if (timer.severity === 'P0') candidates.push({ type: 'new_p0', at: start })
  } else {
    candidates.push({ type: 'appeal_received', at: start })
  }
  const p75 = start + Math.floor(((due - start) * 3) / 4)
  if (stop > p75) candidates.push({ type: `${prefix}sla_75` as AlertType, at: p75 })
  if (stop > due) candidates.push({ type: `${prefix}sla_breach` as AlertType, at: due })
  return candidates
    .filter((c) => now.getTime() >= c.at)
    .map((c) => ({ type: c.type, key: `${timer.kind}:${timer.id}:${c.type}`, at: new Date(c.at) }))
    .filter((a) => !sentKeys.has(a.key))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
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
