import { describe, expect, it } from 'vitest'
import { AUDITED_EVENT_TYPES, auditRecordOf, SYSTEM_ACTOR } from '../src/index.ts'

const NOW = new Date('2026-11-11T10:00:00.000Z')
const appRef = { appId: 'app_a', livemode: true }

describe('auditRecordOf', () => {
  it('records a decision made in a request: its actor, target, facts, request id and time', () => {
    const record = auditRecordOf(
      {
        id: 'evt_1',
        type: 'case.decided',
        data: {
          appRef,
          caseId: 'case_1',
          subjectExternalId: 'u_john_doe',
          decisionId: 'dec_1',
          outcome: 'violation',
          categoryId: 'scams_fraud.romance_scam',
          severity: 'P1',
          actionKeys: ['suspend_7d'],
          decidedBy: 'key_1',
          occurredAt: '2026-11-11T09:30:00.000Z',
        },
        meta: { requestId: 'req_1', actor: { type: 'api_key', id: 'key_1' }, publishedAt: new Date('2026-11-11T09:30:01Z') },
      },
      NOW,
    )
    expect(record).toEqual({
      input: {
        at: new Date('2026-11-11T09:30:00.000Z'),
        actor: { type: 'api_key', id: 'key_1' },
        action: 'case.decided',
        target: { type: 'case', id: 'case_1' },
        facts: {
          decision_id: 'dec_1',
          subject_external_id: 'u_john_doe',
          outcome: 'violation',
          category_id: 'scams_fraud.romance_scam',
          severity: 'P1',
          action_keys: ['suspend_7d'],
          decided_by: 'key_1',
          request_id: 'req_1',
        },
      },
      caseId: 'case_1',
      subjectExternalId: 'u_john_doe',
    })
  })

  it('names the system for work outside a request, and falls back to when the event was published, then to now', () => {
    const triaged = { id: 'evt_2', type: 'case.triaged', data: { appRef, caseId: 'case_1', severity: 'P2', signals: [] } }
    expect(auditRecordOf(triaged, NOW)).toMatchObject({ input: { actor: SYSTEM_ACTOR, at: NOW, facts: { severity: 'P2', signals: [] } }, caseId: 'case_1', subjectExternalId: null })
    const published = new Date('2026-11-11T09:59:00Z')
    expect(auditRecordOf({ ...triaged, meta: { publishedAt: published } }, NOW)?.input.at).toEqual(published)
    // On the memory bus, occurredAt is still a Date.
    const claimed = { id: 'evt_3', type: 'case.claimed', data: { appRef, caseId: 'case_1', memberId: 'key_1', occurredAt: published } }
    expect(auditRecordOf(claimed, NOW)?.input).toMatchObject({ at: published, facts: { holder: 'key_1' } })
  })

  it('finds an action request by its case, and leaves out what an event does not say', () => {
    const record = auditRecordOf({ id: 'evt_4', type: 'action.confirmed', data: { appRef, actionRequestId: 'acr_1', caseId: 'case_1' } }, NOW)
    expect(record).toMatchObject({ input: { target: { type: 'action_request', id: 'acr_1' }, facts: { case_id: 'case_1' } }, caseId: 'case_1' })
    expect(Object.keys(record!.input.facts)).toEqual(['case_id'])
    expect(record!.input).not.toHaveProperty('pii')
  })

  it('copies only the listed facts, so nothing else in an event reaches the log', () => {
    const record = auditRecordOf({ id: 'evt_5', type: 'report.received', data: { appRef, reportId: 'rpt_1', subjectExternalId: 'u_john_doe', p0Signal: false, text: 'free text' } }, NOW)
    expect(record?.input.facts).toEqual({ subject_external_id: 'u_john_doe', p0_signal: false })
  })

  it('skips types it does not record, and refuses an event without its target id', () => {
    expect(auditRecordOf({ id: 'evt_6', type: 'case.unknown', data: {} }, NOW)).toBeNull()
    expect(() => auditRecordOf({ id: 'evt_7', type: 'case.opened', data: { appRef } }, NOW)).toThrow('has no caseId')
    expect(AUDITED_EVENT_TYPES).toContain('config.action_keys_replaced')
    expect(AUDITED_EVENT_TYPES).toContain('api_key.revoked')
  })
})
