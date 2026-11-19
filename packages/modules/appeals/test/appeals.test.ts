import { manualClock, type ManualClock, type TenantRef } from '@flagwise/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppealError, appealDeadline, fileAppeal, resolveAppeal, type FileAppealInput } from '../src/app/appeals.ts'
import { VersionConflictError, type AppealRecord, type AppealsDeps, type DecisionView } from '../src/app/ports.ts'
import { InMemoryAppeals, InMemoryDecisions, RecordingPublisher } from './fakes.ts'

const tenant: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const DECIDED = new Date('2026-11-03T09:00:00.000Z')
const DAY = 86_400_000
const REVERSE: Record<string, string> = { suspend_7d: 'unsuspend', hide_content: 'unhide_content' }

let decisions: InMemoryDecisions
let appeals: InMemoryAppeals
let publisher: RecordingPublisher
let clock: ManualClock
let deps: AppealsDeps
let ids: number

const decision = (o: Partial<DecisionView> = {}): DecisionView => ({
  decisionId: 'dec_1',
  tenant,
  caseId: 'case_1',
  outcome: 'violation',
  actionKeys: ['suspend_7d', 'warn', 'hide_content'],
  decidedBy: 'mem_jane',
  decidedAt: DECIDED,
  subjectExternalId: 'u_5531',
  reporterExternalIds: ['u_1029', 'u_2040'],
  ...o,
})

beforeEach(() => {
  decisions = new InMemoryDecisions()
  appeals = new InMemoryAppeals()
  publisher = new RecordingPublisher()
  clock = manualClock(new Date(DECIDED.getTime() + DAY))
  ids = 0
  deps = {
    decisions,
    appeals,
    reverseKeys: { reverseOf: async (_t, key) => REVERSE[key] ?? null },
    events: publisher,
    clock,
    newAppealId: () => `apl_${++ids}`,
  }
  decisions.rows.set('dec_1', decision())
  decisions.rows.set('dec_nv', decision({ decisionId: 'dec_nv', outcome: 'no_violation', actionKeys: [] }))
})

const reportedAppeal = (o: Partial<FileAppealInput> = {}): FileAppealInput => ({
  tenant,
  decisionId: 'dec_1',
  appellant: 'reported',
  appellantExternalId: 'u_5531',
  text: '  I was joking with a friend.  ',
  ...o,
})

async function rejectsWith(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => expect.unreachable('should have thrown'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(AppealError)
  expect((err as AppealError).code).toBe(code)
}

describe('appealDeadline', () => {
  it.each([
    ['2026-11-03T09:00:00.000Z', '2027-05-03T09:00:00.000Z'],
    ['2026-08-31T23:59:59.999Z', '2027-02-28T23:59:59.999Z'],
    ['2027-08-31T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
    ['2026-12-31T12:00:00.000Z', '2027-06-30T12:00:00.000Z'],
    ['2026-07-31T00:00:00.000Z', '2027-01-31T00:00:00.000Z'],
    ['2026-03-30T06:30:00.000Z', '2026-09-30T06:30:00.000Z'],
  ])('%s -> %s', (from, to) => {
    expect(appealDeadline(new Date(from)).toISOString()).toBe(to)
  })
})

describe('fileAppeal', () => {
  it('files an appeal by the reported user and publishes appeal.filed', async () => {
    const now = clock.now()
    const r = await fileAppeal(deps, reportedAppeal())
    const expected: AppealRecord = {
      id: 'apl_1',
      tenant,
      decisionId: 'dec_1',
      caseId: 'case_1',
      appellant: 'reported',
      appellantExternalId: 'u_5531',
      text: 'I was joking with a friend.',
      filedAt: now,
      dueAt: new Date(now.getTime() + 7 * DAY),
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      version: 1,
    }
    expect(r).toEqual(expected)
    expect(appeals.all()).toEqual([expected])
    expect(publisher.events).toEqual([
      { type: 'appeal.filed', tenant, appealId: 'apl_1', decisionId: 'dec_1', caseId: 'case_1', appellant: 'reported', dueAt: expected.dueAt, occurredAt: now },
    ])
  })

  it('lets each reporter appeal a "no violation" decision once', async () => {
    await fileAppeal(deps, reportedAppeal({ decisionId: 'dec_nv', appellant: 'reporter', appellantExternalId: 'u_1029' }))
    await fileAppeal(deps, reportedAppeal({ decisionId: 'dec_nv', appellant: 'reporter', appellantExternalId: 'u_2040' }))
    expect(appeals.all().map((a) => a.appellantExternalId)).toEqual(['u_1029', 'u_2040'])
    await rejectsWith(fileAppeal(deps, reportedAppeal({ decisionId: 'dec_nv', appellant: 'reporter', appellantExternalId: 'u_1029' })), 'already_appealed')
  })

  it('allows one appeal per party even after it was resolved', async () => {
    await fileAppeal(deps, reportedAppeal())
    await resolveAppeal(deps, { tenant, appealId: 'apl_1', reviewerId: 'mem_john', outcome: 'upheld' })
    await rejectsWith(fileAppeal(deps, reportedAppeal()), 'already_appealed')
  })

  it.each<[string, Partial<FileAppealInput>, string]>([
    ['an unknown decision', { decisionId: 'dec_x' }, 'decision_not_found'],
    ['a decision of another tenant', { tenant: { ...tenant, livemode: false } }, 'decision_not_found'],
    ['blank text', { text: '   ' }, 'invalid_text'],
    ['text over 2000 characters', { text: 'x'.repeat(2001) }, 'invalid_text'],
    ['someone who is not the reported user', { appellantExternalId: 'u_1029' }, 'not_a_party'],
    ['someone who is not a reporter', { appellant: 'reporter', appellantExternalId: 'u_5531' }, 'not_a_party'],
    ['the reported user against "no violation"', { decisionId: 'dec_nv' }, 'nothing_to_appeal'],
    ['a reporter against a violation', { appellant: 'reporter', appellantExternalId: 'u_1029' }, 'nothing_to_appeal'],
  ])('rejects %s', async (_label, patch, code) => {
    await rejectsWith(fileAppeal(deps, reportedAppeal(patch)), code)
    expect(appeals.all()).toEqual([])
    expect(publisher.events).toEqual([])
  })

  it('accepts exactly 2000 characters after trimming', async () => {
    const r = await fileAppeal(deps, reportedAppeal({ text: ` ${'x'.repeat(2000)} ` }))
    expect(r.text).toHaveLength(2000)
  })

  it('checks the text before the party', async () => {
    await rejectsWith(fileAppeal(deps, reportedAppeal({ text: '', appellantExternalId: 'u_nobody' })), 'invalid_text')
  })

  it('accepts an appeal at the deadline and refuses one after it', async () => {
    clock.set(new Date('2027-05-03T09:00:00.000Z'))
    await fileAppeal(deps, reportedAppeal())
    clock.set(new Date('2027-05-03T09:00:00.001Z'))
    await rejectsWith(fileAppeal(deps, reportedAppeal({ decisionId: 'dec_nv', appellant: 'reporter', appellantExternalId: 'u_1029' })), 'window_closed')
  })
})

describe('resolveAppeal', () => {
  const resolve = (outcome: 'upheld' | 'overturned', reviewerId = 'mem_john') => resolveAppeal(deps, { tenant, appealId: 'apl_1', reviewerId, outcome })

  it('upholds a decision', async () => {
    await fileAppeal(deps, reportedAppeal())
    clock.advance(DAY)
    const now = clock.now()
    const r = await resolve('upheld')
    expect(r).toMatchObject({ status: 'upheld', resolvedBy: 'mem_john', resolvedAt: now, version: 2 })
    expect(appeals.get('apl_1')).toEqual(r)
    expect(publisher.events[1]).toEqual({
      type: 'appeal.resolved',
      tenant,
      appealId: 'apl_1',
      decisionId: 'dec_1',
      caseId: 'case_1',
      outcome: 'upheld',
      reverseActionKeys: [],
      irreversibleActionKeys: [],
      revokePoints: false,
      reopenCase: false,
      resolvedBy: 'mem_john',
      occurredAt: now,
    })
  })

  it('overturns a sanction: reverse actions, irreversible ones listed, points revoked', async () => {
    await fileAppeal(deps, reportedAppeal())
    await resolve('overturned')
    expect(publisher.events[1]).toMatchObject({
      outcome: 'overturned',
      reverseActionKeys: ['unsuspend', 'unhide_content'],
      irreversibleActionKeys: ['warn'],
      revokePoints: true,
      reopenCase: false,
    })
  })

  it('reopens the case when a reporter wins against "no violation"', async () => {
    await fileAppeal(deps, reportedAppeal({ decisionId: 'dec_nv', appellant: 'reporter', appellantExternalId: 'u_1029' }))
    await resolve('overturned')
    expect(publisher.events[1]).toMatchObject({ reverseActionKeys: [], irreversibleActionKeys: [], revokePoints: false, reopenCase: true })
  })

  it('needs a reviewer other than the decider', async () => {
    await fileAppeal(deps, reportedAppeal())
    await rejectsWith(resolve('overturned', 'mem_jane'), 'reviewer_is_decider')
    expect(appeals.get('apl_1')?.status).toBe('open')
  })

  it('refuses to resolve when the decision is missing, and writes nothing', async () => {
    await fileAppeal(deps, reportedAppeal())
    decisions.rows.delete('dec_1')
    await rejectsWith(resolve('overturned'), 'decision_not_found')
    expect(appeals.get('apl_1')).toMatchObject({ status: 'open', version: 1 })
    expect(appeals.calls.filter((c) => c === 'update')).toHaveLength(0)
    expect(publisher.events).toHaveLength(1)
  })

  it('reports an already resolved appeal before a missing decision', async () => {
    await fileAppeal(deps, reportedAppeal())
    await resolve('upheld')
    decisions.rows.delete('dec_1')
    await rejectsWith(resolve('overturned', 'mem_lead'), 'already_resolved')
  })

  it('refuses an unknown or already resolved appeal', async () => {
    await rejectsWith(resolve('upheld'), 'appeal_not_found')
    await fileAppeal(deps, reportedAppeal())
    await resolve('upheld')
    await rejectsWith(resolve('overturned', 'mem_lead'), 'already_resolved')
    expect(publisher.events).toHaveLength(2)
  })

  it('gives a second reviewer racing the first "already_resolved"', async () => {
    await fileAppeal(deps, reportedAppeal())
    let first = true
    appeals.beforeUpdate = () => {
      if (first) {
        first = false
        appeals.seed({ ...appeals.get('apl_1')!, status: 'upheld', resolvedBy: 'mem_lead', resolvedAt: clock.now(), version: 2 })
      }
    }
    await rejectsWith(resolve('overturned'), 'already_resolved')
    expect(appeals.get('apl_1')?.resolvedBy).toBe('mem_lead')
    expect(publisher.events).toHaveLength(1)
  })

  it('retries once after an unrelated conflict, then gives up', async () => {
    await fileAppeal(deps, reportedAppeal())
    appeals.failUpdatesWith = [new VersionConflictError('apl_1')]
    await resolve('upheld')
    expect(appeals.get('apl_1')?.status).toBe('upheld')

    await fileAppeal(deps, reportedAppeal({ decisionId: 'dec_nv', appellant: 'reporter', appellantExternalId: 'u_1029' }))
    appeals.failUpdatesWith = [new VersionConflictError('apl_2'), new VersionConflictError('apl_2')]
    await expect(resolveAppeal(deps, { tenant, appealId: 'apl_2', reviewerId: 'mem_john', outcome: 'upheld' })).rejects.toBeInstanceOf(VersionConflictError)
    expect(appeals.get('apl_2')?.status).toBe('open')
  })
})
