import { describe, expect, it } from 'vitest'
import { routeAlert, slaStatus, timerAlerts, type Timer } from '../src/domain/sla.ts'

const T0 = new Date('2026-11-03T09:00:00.000Z').getTime()
const MIN = 60_000
const H = 60 * MIN
const at = (ms: number) => new Date(T0 + ms)

const p1 = (o: Partial<Timer> = {}): Timer => ({ kind: 'case', id: 'case_1', severity: 'P1', startedAt: at(0), dueAt: at(24 * H), stoppedAt: null, ...o })
const p0 = (o: Partial<Timer> = {}): Timer => p1({ severity: 'P0', dueAt: at(H), ...o })
const appeal = (o: Partial<Timer> = {}): Timer => ({ kind: 'appeal', id: 'apl_1', startedAt: at(0), dueAt: at(7 * 24 * H), stoppedAt: null, ...o })
const none = new Set<string>()

describe('slaStatus', () => {
  it('runs, then breaches', () => {
    expect(slaStatus(p1(), at(6 * H))).toEqual({ state: 'running', elapsedRatio: 0.25, remainingMs: 18 * H })
    expect(slaStatus(p1(), at(24 * H))).toEqual({ state: 'breached', elapsedRatio: 1, remainingMs: 0 })
    expect(slaStatus(p1(), at(30 * H))).toEqual({ state: 'breached', elapsedRatio: 1.25, remainingMs: -6 * H })
  })

  it('stops at the first decision', () => {
    expect(slaStatus(p1({ stoppedAt: at(12 * H) }), at(100 * H))).toEqual({ state: 'met', elapsedRatio: 0.5, remainingMs: 12 * H })
    expect(slaStatus(p1({ stoppedAt: at(24 * H) }), at(100 * H)).state).toBe('met')
    expect(slaStatus(p1({ stoppedAt: at(36 * H) }), at(100 * H))).toEqual({ state: 'missed', elapsedRatio: 1.5, remainingMs: -12 * H })
  })

  it('ignores a stop that is still in the future', () => {
    expect(slaStatus(p1({ stoppedAt: at(12 * H) }), at(6 * H)).state).toBe('running')
  })

  it('never reports a negative ratio', () => {
    expect(slaStatus(p1(), at(-H))).toEqual({ state: 'running', elapsedRatio: 0, remainingMs: 25 * H })
  })

  it('rejects a due time that is not after the start', () => {
    expect(() => slaStatus(p1({ dueAt: at(0) }), at(0))).toThrow(RangeError)
    expect(() => timerAlerts(p1({ dueAt: at(-1) }), none, at(0))).toThrow(RangeError)
  })
})

describe('timerAlerts', () => {
  it('alerts on a new P0 case immediately', () => {
    expect(timerAlerts(p0(), none, at(0))).toEqual([{ type: 'new_p0', key: 'case:case_1:new_p0', at: at(0) }])
    expect(timerAlerts(p1(), none, at(0))).toEqual([])
  })

  it('alerts at 75% and at breach', () => {
    expect(timerAlerts(p1(), none, at(18 * H - 1))).toEqual([])
    expect(timerAlerts(p1(), none, at(18 * H))).toEqual([{ type: 'sla_75', key: 'case:case_1:sla_75', at: at(18 * H) }])
    expect(timerAlerts(p1(), none, at(30 * H))).toEqual([
      { type: 'sla_75', key: 'case:case_1:sla_75', at: at(18 * H) },
      { type: 'sla_breach', key: 'case:case_1:sla_breach', at: at(24 * H) },
    ])
  })

  it('sends each alert once', () => {
    const sent = new Set(['case:case_1:new_p0', 'case:case_1:sla_75'])
    expect(timerAlerts(p0(), sent, at(2 * H))).toEqual([{ type: 'sla_breach', key: 'case:case_1:sla_breach', at: at(H) }])
  })

  it('orders alerts at the same moment by type', () => {
    const tiny = p0({ dueAt: at(1) })
    expect(timerAlerts(tiny, none, at(10)).map((a) => a.type)).toEqual(['new_p0', 'sla_75', 'sla_breach'])
    expect(timerAlerts(tiny, none, at(10))[1]?.at).toEqual(at(0))
  })

  it('rounds the 75% point down to whole milliseconds', () => {
    expect(timerAlerts(p1({ dueAt: at(10) }), none, at(10))[0]?.at).toEqual(at(7))
  })

  it('does not alert once the decision came first', () => {
    expect(timerAlerts(p1({ stoppedAt: at(10 * H) }), none, at(100 * H))).toEqual([])
    expect(timerAlerts(p1({ stoppedAt: at(18 * H) }), none, at(100 * H))).toEqual([])
    expect(timerAlerts(p1({ stoppedAt: at(20 * H) }), none, at(100 * H)).map((a) => a.type)).toEqual(['sla_75'])
    expect(timerAlerts(p0({ stoppedAt: at(MIN) }), none, at(10 * H)).map((a) => a.type)).toEqual(['new_p0'])
  })

  it('handles appeals on their own clock', () => {
    expect(timerAlerts(appeal(), none, at(0))).toEqual([{ type: 'appeal_received', key: 'appeal:apl_1:appeal_received', at: at(0) }])
    expect(timerAlerts(appeal(), new Set(['appeal:apl_1:appeal_received']), at(8 * 24 * H)).map((a) => a.type)).toEqual([
      'appeal_sla_75',
      'appeal_sla_breach',
    ])
    expect(timerAlerts(appeal({ severity: 'P0' }), none, at(0)).map((a) => a.type)).toEqual(['appeal_received'])
  })

  it('returns nothing before the start', () => {
    expect(timerAlerts(p0(), none, at(-1))).toEqual([])
  })
})

describe('routeAlert', () => {
  it('uses the default route', () => {
    expect(routeAlert('sla_75', 'free')).toEqual({ channels: ['email'], roles: ['owner', 'admin', 'app_admin'], dropped: [] })
    expect(routeAlert('new_p0', 'pro')).toEqual({ channels: ['email'], roles: ['owner', 'admin', 'app_admin', 'moderator'], dropped: [] })
    expect(routeAlert('sla_breach', 'free').roles).toContain('moderator')
    expect(routeAlert('credits_low', 'free').roles).toEqual(['owner', 'admin', 'app_admin'])
  })

  it('lets Pro apps use Slack and Discord', () => {
    const routes = { new_p0: { channels: ['discord', 'email', 'slack', 'slack'] as const, roles: ['moderator', 'owner'] as const } }
    expect(routeAlert('new_p0', 'pro', routes)).toEqual({ channels: ['email', 'slack', 'discord'], roles: ['owner', 'moderator'], dropped: [] })
  })

  it('drops Slack and Discord on Free', () => {
    const routes = { sla_breach: { channels: ['slack', 'email', 'discord'] as const, roles: ['app_admin'] as const } }
    expect(routeAlert('sla_breach', 'free', routes)).toEqual({ channels: ['email'], roles: ['app_admin'], dropped: ['slack', 'discord'] })
  })

  it('falls back to email when nothing allowed is left', () => {
    const routes = { webhook_failing: { channels: ['discord', 'slack'] as const, roles: ['developer'] as const } }
    expect(routeAlert('webhook_failing', 'free', routes)).toEqual({ channels: ['email'], roles: ['developer'], dropped: ['slack', 'discord'] })
    expect(routeAlert('webhook_failing', 'pro', { webhook_failing: { channels: [], roles: ['developer'] } }).channels).toEqual(['email'])
  })

  it('uses an app route only for its own type', () => {
    const routes = { sla_75: { channels: ['slack'] as const, roles: ['moderator'] as const } }
    expect(routeAlert('sla_breach', 'pro', routes)).toEqual({
      channels: ['email'],
      roles: ['owner', 'admin', 'app_admin', 'moderator'],
      dropped: [],
    })
  })
})
