import { describe, expect, it } from 'vitest'
import { routeAlert } from '../src/domain/routing.ts'

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
