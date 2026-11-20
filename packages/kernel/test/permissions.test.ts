// The role matrix, the rules for granting roles, cross-app evidence, API keys and embedded staff.
import { describe, expect, it } from 'vitest'
import {
  can,
  type ApiKeyScope,
  type AppAction,
  type AppRole,
  type AdminAction,
  type AdminRole,
  type Caller,
} from '../src/index.ts'

const A = 'app_a'
const B = 'app_b'

function member(adminRole: AdminRole | null, appRoles: Record<string, AppRole> = {}, livemode = true): Caller {
  return {
    appId: undefined,
    appIds: adminRole ? [A, B] : Object.keys(appRoles),
    actor: { type: 'member', id: 'mem_1' },
    adminRole,
    appRoles,
    livemode,
  }
}

function apiKey(scopes: ApiKeyScope[], appId = A): Caller {
  return {
    appId,
    appIds: [appId],
    actor: { type: 'api_key', id: 'key_1', scopes },
    adminRole: null,
    appRoles: {},
    livemode: true,
  }
}

function embed(role: AppRole, appId = A): Caller {
  return {
    appId,
    appIds: [appId],
    actor: { type: 'embed', sub: 'staff_9', name: 'Staff' },
    adminRole: null,
    appRoles: { [appId]: role },
    livemode: true,
  }
}

const system: Caller = {
  appId: A,
  appIds: [A],
  actor: { type: 'system' },
  adminRole: null,
  appRoles: {},
  livemode: true,
}

const owner = member('owner')
const admin = member('admin')
const appAdminA = member(null, { [A]: 'app_admin' })
const moderatorA = member(null, { [A]: 'moderator' })
const noRole = member(null)
const developerLive = member(null, { [A]: 'developer' })
const developerTest = member(null, { [A]: 'developer' }, false)

describe('app actions', () => {
  // [action, App Admin, Moderator, Developer in live mode, Developer in test mode]
  // Owner and Admin hold every app action members may use.
  const matrix: [AppAction, boolean, boolean, boolean, boolean][] = [
    ['config.read', true, true, true, true],
    ['integration.configure', true, false, true, true],
    ['policy.configure', true, false, false, false],
    ['api_key.manage', true, false, true, true],
    ['case.work', true, true, false, true],
    ['account.read', true, true, false, true],
    ['score.adjust', true, true, false, true],
    ['appeal.review', true, true, false, true],
    ['legal_hold.manage', true, false, false, true],
    ['evidence.export', true, false, false, true],
    ['subject.erase', true, false, false, true],
    ['support_bundle.send', true, true, false, true],
    ['audit.read', true, true, false, true],
    ['metrics.read', true, true, true, true],
    ['notification.read', true, true, true, true],
    ['categories.read', true, true, true, true],
  ]

  describe.each(matrix)('%s', (action, appAdminOk, moderatorOk, devLiveOk, devTestOk) => {
    it('follows the role matrix on an app the member belongs to', () => {
      expect(can(owner, { action, appId: A })).toBe(true)
      expect(can(admin, { action, appId: A })).toBe(true)
      expect(can(appAdminA, { action, appId: A })).toBe(appAdminOk)
      expect(can(moderatorA, { action, appId: A })).toBe(moderatorOk)
    })

    it('gives a Developer live access only to integration, and test-mode access like an App Admin', () => {
      expect(can(developerLive, { action, appId: A })).toBe(devLiveOk)
      expect(can(developerTest, { action, appId: A })).toBe(devTestOk)
    })

    it('is denied on an app the member has no role in', () => {
      expect(can(appAdminA, { action, appId: B })).toBe(false)
      expect(can(moderatorA, { action, appId: B })).toBe(false)
      expect(can(developerTest, { action, appId: B })).toBe(false)
      expect(can(noRole, { action, appId: A })).toBe(false)
    })

    it('is allowed on every app for admin roles', () => {
      expect(can(owner, { action, appId: B })).toBe(true)
      expect(can(admin, { action, appId: B })).toBe(true)
    })
  })

  it('does not let test mode widen App Admin or Moderator access', () => {
    expect(can(member(null, { [A]: 'moderator' }, false), { action: 'policy.configure', appId: A })).toBe(false)
    expect(can(member(null, { [A]: 'moderator' }, false), { action: 'evidence.export', appId: A })).toBe(false)
  })

  it('uses the role of each app separately for a member with different roles per app', () => {
    const mixed = member(null, { [A]: 'app_admin', [B]: 'moderator' })
    expect(can(mixed, { action: 'policy.configure', appId: A })).toBe(true)
    expect(can(mixed, { action: 'policy.configure', appId: B })).toBe(false)
    expect(can(mixed, { action: 'case.work', appId: B })).toBe(true)
  })
})

describe('admin actions', () => {
  // [action, Owner, Admin]; App Admins and Moderators never
  const matrix: [AdminAction, boolean, boolean][] = [
    ['billing.manage', true, false],
    ['app.create', true, true],
    ['app.delete', true, true],
    ['member.remove', true, true],
    ['ownership.transfer', true, false],
  ]

  it.each(matrix)('%s', (action, ownerOk, adminOk) => {
    expect(can(owner, { action })).toBe(ownerOk)
    expect(can(admin, { action })).toBe(adminOk)
    expect(can(appAdminA, { action })).toBe(false)
    expect(can(moderatorA, { action })).toBe(false)
    expect(can(developerTest, { action })).toBe(false)
  })
})

describe.each(['member.invite', 'role.assign'] as const)('%s', (action) => {
  it('never grants Owner; ownership only moves by transfer', () => {
    expect(can(owner, { action, role: 'owner' })).toBe(false)
    expect(can(admin, { action, role: 'owner' })).toBe(false)
  })

  it('lets Owner and Admin grant Admin', () => {
    expect(can(owner, { action, role: 'admin' })).toBe(true)
    expect(can(admin, { action, role: 'admin' })).toBe(true)
    expect(can(appAdminA, { action, role: 'admin' })).toBe(false)
  })

  it('lets Owner and Admin grant app roles in any app', () => {
    for (const role of ['app_admin', 'moderator', 'developer'] as const) {
      expect(can(owner, { action, role, appId: B })).toBe(true)
      expect(can(admin, { action, role, appId: B })).toBe(true)
    }
  })

  it('lets an App Admin grant Moderator or Developer in their own app only', () => {
    expect(can(appAdminA, { action, role: 'moderator', appId: A })).toBe(true)
    expect(can(appAdminA, { action, role: 'developer', appId: A })).toBe(true)
    expect(can(appAdminA, { action, role: 'moderator', appId: B })).toBe(false)
    expect(can(appAdminA, { action, role: 'app_admin', appId: A })).toBe(false)
  })

  it('never lets a Moderator or Developer grant anything', () => {
    expect(can(moderatorA, { action, role: 'moderator', appId: A })).toBe(false)
    expect(can(developerTest, { action, role: 'developer', appId: A })).toBe(false)
  })

  it('rejects an app role without an app, and an admin role with one', () => {
    expect(can(owner, { action, role: 'moderator' })).toBe(false)
    expect(can(owner, { action, role: 'admin', appId: A })).toBe(false)
  })
})

describe('evidence.cross_app_full', () => {
  const crossAB = { action: 'evidence.cross_app_full', appId: A, otherAppId: B } as const

  it('is allowed for Owner and Admin', () => {
    expect(can(owner, crossAB)).toBe(true)
    expect(can(admin, crossAB)).toBe(true)
  })

  it('needs access to both apps, with any app role', () => {
    expect(can(moderatorA, crossAB)).toBe(false)
    expect(can(member(null, { [A]: 'moderator', [B]: 'moderator' }), crossAB)).toBe(true)
    expect(can(member(null, { [A]: 'app_admin', [B]: 'moderator' }), crossAB)).toBe(true)
  })

  it('does not count a Developer role as access, since developers never see live evidence', () => {
    expect(can(member(null, { [A]: 'moderator', [B]: 'developer' }), crossAB)).toBe(false)
  })
})

describe('API keys', () => {
  const byScope: [ApiKeyScope, AppAction[]][] = [
    ['flagging', ['report.create', 'categories.read', 'identifiers.check']],
    ['actions', ['action_request.respond', 'appeal.file']],
    [
      'admin',
      [
        'config.read',
        'integration.configure',
        'policy.configure',
        'case.work',
        'account.read',
        'score.adjust',
        'appeal.review',
        'legal_hold.manage',
        'evidence.export',
        'subject.erase',
        'audit.read',
        'metrics.read',
        'notification.read',
      ],
    ],
  ]

  describe.each(byScope)('scope %s', (scope, actions) => {
    it.each(actions)('allows %s on its own app', (action) => {
      expect(can(apiKey([scope]), { action, appId: A })).toBe(true)
    })

    it.each(actions)('denies %s without the scope', (action) => {
      const others = (['flagging', 'actions', 'admin'] as const).filter((s) => s !== scope)
      expect(can(apiKey([...others]), { action, appId: A })).toBe(false)
    })

    it.each(actions)('denies %s on another app', (action) => {
      expect(can(apiKey(['flagging', 'actions', 'admin']), { action, appId: B })).toBe(false)
    })
  })

  it('never manages API keys, sends support bundles, or touches settings across apps or roles', () => {
    const all = apiKey(['flagging', 'actions', 'admin'])
    expect(can(all, { action: 'api_key.manage', appId: A })).toBe(false)
    expect(can(all, { action: 'support_bundle.send', appId: A })).toBe(false)
    expect(can(all, { action: 'billing.manage' })).toBe(false)
    expect(can(all, { action: 'app.create' })).toBe(false)
    expect(can(all, { action: 'member.invite', role: 'moderator', appId: A })).toBe(false)
    expect(can(all, { action: 'evidence.cross_app_full', appId: A, otherAppId: B })).toBe(false)
  })
})

describe('appRef backend calls are API-key only', () => {
  it.each(['report.create', 'identifiers.check', 'action_request.respond', 'appeal.file'] as const)(
    'denies %s to dashboard members',
    (action) => {
      expect(can(owner, { action, appId: A })).toBe(false)
    },
  )
})

describe('embedded staff', () => {
  it('get the app actions of their embed role, on the embedded app only', () => {
    expect(can(embed('moderator'), { action: 'case.work', appId: A })).toBe(true)
    expect(can(embed('moderator'), { action: 'policy.configure', appId: A })).toBe(false)
    expect(can(embed('app_admin'), { action: 'policy.configure', appId: A })).toBe(true)
    expect(can(embed('app_admin'), { action: 'case.work', appId: B })).toBe(false)
  })

  it('cannot carry the Developer role', () => {
    expect(can(embed('developer'), { action: 'config.read', appId: A })).toBe(false)
  })

  it('never manage API keys, webhook destinations, settings across apps or members', () => {
    expect(can(embed('app_admin'), { action: 'api_key.manage', appId: A })).toBe(false)
    expect(can(embed('app_admin'), { action: 'integration.configure', appId: A })).toBe(false)
    expect(can(embed('app_admin'), { action: 'app.create' })).toBe(false)
    expect(can(embed('app_admin'), { action: 'member.invite', role: 'moderator', appId: A })).toBe(false)
  })
})

describe('system actor', () => {
  it('is denied: background jobs do not authorize through can()', () => {
    expect(can(system, { action: 'case.work', appId: A })).toBe(false)
    expect(can(system, { action: 'billing.manage' })).toBe(false)
  })
})
