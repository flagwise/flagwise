import { manualClock, type TenantRef } from '@flagwise/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { CaseChangedError, type CaseRecord, type ModerationDeps } from '../src/app/ports.ts'
import { receiveReport, type ReportReceived } from '../src/app/receive-report.ts'
import type { CaseState } from '../src/domain/case-state.ts'
import { InMemoryCaseRepository, RecordingPublisher } from './fakes.ts'

const tenant: TenantRef = { orgId: 'org_1', appId: 'app_a', livemode: true }
const NOW = '2026-11-03T09:00:00.000Z'

let repo: InMemoryCaseRepository
let publisher: RecordingPublisher
let deps: ModerationDeps
let nextId: number

beforeEach(() => {
  repo = new InMemoryCaseRepository()
  publisher = new RecordingPublisher()
  nextId = 1
  deps = { cases: repo, events: publisher, clock: manualClock(NOW), newCaseId: () => `case_new${nextId++}` }
})

const report = (o: Partial<ReportReceived> = {}): ReportReceived => ({
  tenant,
  reportId: 'rpt_1',
  subjectExternalId: 'u_5531',
  p0Signal: false,
  ...o,
})

const existing = (o: Partial<CaseRecord> = {}): CaseRecord => ({
  id: 'case_old',
  tenant,
  subjectExternalId: 'u_5531',
  band: 'standard',
  state: 'open',
  reportIds: ['rpt_0'],
  openedAt: new Date('2026-11-01T00:00:00.000Z'),
  ...o,
})

describe('opening a case', () => {
  it('opens a classifying case when the account has none', async () => {
    const result = await receiveReport(deps, report())
    expect(result).toEqual({ caseId: 'case_new1', joinedExistingCase: false, duplicate: false })
    expect(repo.all()).toEqual([
      {
        id: 'case_new1',
        tenant,
        subjectExternalId: 'u_5531',
        band: 'standard',
        state: 'classifying',
        reportIds: ['rpt_1'],
        openedAt: new Date(NOW),
      },
    ])
  })

  it('publishes case.opened', async () => {
    await receiveReport(deps, report({ p0Signal: true }))
    expect(publisher.events).toEqual([
      {
        type: 'case.opened',
        tenant,
        caseId: 'case_new1',
        reportId: 'rpt_1',
        subjectExternalId: 'u_5531',
        band: 'p0',
        occurredAt: new Date(NOW),
      },
    ])
  })

  it.each<CaseState>(['decided', 'actioned', 'action_failed', 'appealed', 'closed'])(
    'opens a new case when the existing one is %s',
    async (state) => {
      repo.seed(existing({ state }))
      const result = await receiveReport(deps, report())
      expect(result.caseId).toBe('case_new1')
      expect(repo.get('case_old')?.reportIds).toEqual(['rpt_0'])
    },
  )

  it('does not join cases of another account', async () => {
    repo.seed(existing({ subjectExternalId: 'u_other' }))
    expect((await receiveReport(deps, report())).caseId).toBe('case_new1')
  })

  it.each<[string, TenantRef]>([
    ['another app', { ...tenant, appId: 'app_b' }],
    ['another org', { ...tenant, orgId: 'org_2' }],
    ['test mode', { ...tenant, livemode: false }],
  ])('does not join a case in %s', async (_label, other) => {
    repo.seed(existing({ tenant: other }))
    const result = await receiveReport(deps, report())
    expect(result.caseId).toBe('case_new1')
    expect(repo.get('case_new1')?.tenant).toEqual(tenant)
  })
})

describe('joining a case', () => {
  it.each<CaseState>(['classifying', 'untriaged', 'open', 'claimed'])(
    'joins the open case when it is %s',
    async (state) => {
      repo.seed(existing({ state }))
      const result = await receiveReport(deps, report())
      expect(result).toEqual({ caseId: 'case_old', joinedExistingCase: true, duplicate: false })
      expect(repo.get('case_old')).toEqual(existing({ state, reportIds: ['rpt_0', 'rpt_1'] }))
      expect(repo.all()).toHaveLength(1)
    },
  )

  it('publishes case.report_attached', async () => {
    repo.seed(existing())
    await receiveReport(deps, report())
    expect(publisher.events).toEqual([{ type: 'case.report_attached', tenant, caseId: 'case_old', reportId: 'rpt_1', occurredAt: new Date(NOW) }])
  })

  it('keeps P0 reports apart from ordinary cases, and the other way round', async () => {
    repo.seed(existing({ id: 'case_std', band: 'standard' }))
    expect((await receiveReport(deps, report({ reportId: 'rpt_p0', p0Signal: true }))).caseId).toBe('case_new1')

    repo.seed(existing({ id: 'case_p0only', subjectExternalId: 'u_9', band: 'p0' }))
    const std = await receiveReport(deps, report({ reportId: 'rpt_std', subjectExternalId: 'u_9' }))
    expect(std.caseId).toBe('case_new2')
  })

  it('joins the case of the matching band when the account has both', async () => {
    repo.seed(
      existing({ id: 'case_std', band: 'standard' }),
      existing({ id: 'case_p0', band: 'p0', openedAt: new Date('2026-10-01T00:00:00.000Z') }),
    )
    expect((await receiveReport(deps, report({ reportId: 'rpt_a' }))).caseId).toBe('case_std')
    expect((await receiveReport(deps, report({ reportId: 'rpt_b', p0Signal: true }))).caseId).toBe('case_p0')
  })

  it('picks the earliest opened case when several could take the report', async () => {
    repo.seed(
      existing({ id: 'case_late', openedAt: new Date('2026-11-02T00:00:00.000Z') }),
      existing({ id: 'case_early', openedAt: new Date('2026-10-30T00:00:00.000Z') }),
      existing({ id: 'case_mid', openedAt: new Date('2026-11-01T00:00:00.000Z') }),
    )
    expect((await receiveReport(deps, report())).caseId).toBe('case_early')
  })

  it('ignores a closed case that was opened earlier', async () => {
    repo.seed(
      existing({ id: 'case_closed', state: 'closed', openedAt: new Date('2026-01-01T00:00:00.000Z') }),
      existing({ id: 'case_open' }),
    )
    expect((await receiveReport(deps, report())).caseId).toBe('case_open')
  })

  it('only attaches the report, leaving the rest of the case alone', async () => {
    repo.seed(existing({ state: 'claimed', claim: { memberId: 'mem_jane', claimedAt: new Date(NOW), lastActivityAt: new Date(NOW) } }))
    await receiveReport(deps, report())
    expect(repo.calls.filter((c) => c.method === 'change')).toEqual([])
    expect(repo.get('case_old')).toMatchObject({ state: 'claimed', claim: { memberId: 'mem_jane' }, reportIds: ['rpt_0', 'rpt_1'] })
  })
})

describe('duplicate delivery', () => {
  it('returns the same case and writes nothing when the report was already handled', async () => {
    const first = await receiveReport(deps, report())
    const again = await receiveReport(deps, report())
    expect(again).toEqual({ caseId: first.caseId, joinedExistingCase: false, duplicate: true })
    expect(repo.all()).toHaveLength(1)
    expect(publisher.events).toHaveLength(1)
  })

  it('reports joinedExistingCase for a duplicate of a joined report', async () => {
    repo.seed(existing())
    await receiveReport(deps, report())
    const again = await receiveReport(deps, report())
    expect(again).toEqual({ caseId: 'case_old', joinedExistingCase: true, duplicate: true })
    expect(repo.get('case_old')?.reportIds).toEqual(['rpt_0', 'rpt_1'])
    expect(publisher.events).toHaveLength(1)
  })

  it('treats the same report id in another tenant as a different report', async () => {
    await receiveReport(deps, report())
    const other = await receiveReport(deps, report({ tenant: { ...tenant, appId: 'app_b' } }))
    expect(other).toEqual({ caseId: 'case_new2', joinedExistingCase: false, duplicate: false })
  })
})

describe('concurrency', () => {
  it('joins even when another report joined the case meanwhile', async () => {
    repo.seed(existing())
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.attachDirectly('case_old', 'rpt_other')
      }
    }
    const result = await receiveReport(deps, report())
    expect(result).toEqual({ caseId: 'case_old', joinedExistingCase: true, duplicate: false })
    expect(repo.get('case_old')?.reportIds).toEqual(['rpt_0', 'rpt_other', 'rpt_1'])
    expect(repo.calls.filter((c) => c.method === 'attachReport')).toHaveLength(1)
    expect(publisher.events).toEqual([expect.objectContaining({ type: 'case.report_attached' })])
  })

  it('opens a new case on retry when the case stopped accepting reports meanwhile', async () => {
    repo.seed(existing({ state: 'claimed' }))
    let first = true
    repo.beforeWrite = () => {
      if (first) {
        first = false
        repo.seed({ ...repo.get('case_old')!, state: 'decided' })
      }
    }
    const result = await receiveReport(deps, report())
    expect(result).toEqual({ caseId: 'case_new1', joinedExistingCase: false, duplicate: false })
    expect(repo.get('case_old')?.reportIds).toEqual(['rpt_0'])
    expect(publisher.events.map((e) => e.type)).toEqual(['case.opened'])
  })

  // Each time the report is about to join, that case is decided and another open case appears.
  const closeEachTarget = (times: number) => {
    let n = 0
    repo.beforeWrite = (caseId) => {
      if (n >= times) return
      n++
      repo.seed({ ...repo.get(caseId)!, state: 'decided' }, existing({ id: `case_next${n}` }))
    }
  }

  it('stops after three attempts and throws CaseChangedError', async () => {
    repo.seed(existing())
    closeEachTarget(3)
    await expect(receiveReport(deps, report())).rejects.toBeInstanceOf(CaseChangedError)
    expect(repo.calls.filter((c) => c.method === 'attachReport')).toHaveLength(3)
    expect(publisher.events).toEqual([])
  })

  it('succeeds on the third attempt', async () => {
    repo.seed(existing())
    closeEachTarget(2)
    expect((await receiveReport(deps, report())).caseId).toBe('case_next2')
    expect(publisher.events).toHaveLength(1)
  })

  it('does not retry errors', async () => {
    repo.seed(existing())
    repo.failWritesWith = [new Error('connection reset')]
    await expect(receiveReport(deps, report())).rejects.toThrow('connection reset')
    expect(repo.calls.filter((c) => c.method === 'attachReport')).toHaveLength(1)
    expect(publisher.events).toEqual([])
  })

  it('publishes nothing when the insert fails', async () => {
    repo.failInsertWith = new Error('disk full')
    await expect(receiveReport(deps, report())).rejects.toThrow('disk full')
    expect(publisher.events).toEqual([])
  })
})

describe('report facts', () => {
  const facts = { reporterExternalId: 'u_jane_doe', reporterAccountCreatedAt: new Date('2025-04-11T08:00:00.000Z'), reportedAccountCreatedAt: null }

  it('passes the facts of a report on in the event, for a new case and a joined one', async () => {
    await receiveReport(deps, report({ facts }))
    repo.seed(existing())
    await receiveReport(deps, report({ reportId: 'rpt_2', facts }))
    expect(publisher.events.map((e) => [e.type, 'facts' in e ? e.facts : undefined])).toEqual([
      ['case.opened', facts],
      ['case.report_attached', facts],
    ])
  })
})
