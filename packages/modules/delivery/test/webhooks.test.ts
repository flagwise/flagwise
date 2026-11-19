import { describe, expect, it } from 'vitest'
import { matchesFilter, toWebhook, type InternalEvent, type WebhookContext } from '../src/domain/webhooks.ts'

const ctx: WebhookContext = {
  eventId: 'evt_01J9ABC',
  apiVersion: '2026-11-01',
  createdAt: new Date('2026-11-03T09:12:44.000Z'),
  livemode: true,
  appId: 'app_01H',
}
const envelope = { id: 'evt_01J9ABC', api_version: '2026-11-01', created_at: '2026-11-03T09:12:44.000Z', livemode: true, app_id: 'app_01H' }
const due = new Date('2026-11-04T09:00:00.000Z')

describe('toWebhook', () => {
  it('maps case.triaged to report.triaged and drops the summary', () => {
    const e: InternalEvent = {
      type: 'case.triaged',
      caseId: 'case_1',
      reportIds: ['rpt_1', 'rpt_2'],
      categoryId: 'scams_fraud.romance_scam',
      severity: 'P1',
      priority: 2020,
      slaDueAt: due,
      suggestedActionKeys: ['warn'],
      signals: ['off_platform_payment'],
      injectionSuspected: false,
      classifiedBy: 'llm',
      summary: 'Asked Jane Doe for $200',
    }
    expect(toWebhook(e, ctx)).toEqual({
      ...envelope,
      type: 'report.triaged',
      data: {
        case_id: 'case_1',
        report_ids: ['rpt_1', 'rpt_2'],
        category_id: 'scams_fraud.romance_scam',
        custom_category_id: null,
        severity: 'P1',
        priority: 2020,
        sla_due_at: '2026-11-04T09:00:00.000Z',
        suggested_action_keys: ['warn'],
        signals: ['off_platform_payment'],
        injection_suspected: false,
        classified_by: 'llm',
      },
    })
    expect(JSON.stringify(toWebhook(e, ctx))).not.toContain('$200')
  })

  it('keeps the data keys in the listed order', () => {
    const e: InternalEvent = { type: 'case.untriaged', reason: 'no_credit', caseId: 'case_9' }
    expect(Object.keys(toWebhook(e, ctx)!.data)).toEqual(['case_id', 'reason'])
  })

  it('keeps a custom category', () => {
    const e: InternalEvent = {
      type: 'case.triaged',
      caseId: 'case_1',
      reportIds: ['rpt_1'],
      categoryId: 'fake_identity',
      customCategoryId: 'cat_fake_seller',
      severity: 'P2',
      priority: 1020,
      slaDueAt: due,
      suggestedActionKeys: [],
      signals: [],
      injectionSuspected: true,
      classifiedBy: 'rules',
    }
    expect(toWebhook(e, ctx)?.data).toMatchObject({ custom_category_id: 'cat_fake_seller', injection_suspected: true, classified_by: 'rules' })
  })

  it('maps a decision action request', () => {
    const e: InternalEvent = {
      type: 'action.requested',
      actionRequestId: 'acr_1',
      actionKey: 'suspend_7d',
      subjectExternalId: 'u_5531',
      caseId: 'case_1',
      decisionId: 'dec_1',
      categoryId: 'scams_fraud.romance_scam',
      severity: 'P1',
      reason: 'decision',
      requestedBy: { type: 'member', id: 'mem_01H' },
    }
    expect(toWebhook(e, ctx)).toEqual({
      ...envelope,
      type: 'action.requested',
      data: {
        action_request_id: 'acr_1',
        action_key: 'suspend_7d',
        subject_external_id: 'u_5531',
        case_id: 'case_1',
        decision_id: 'dec_1',
        category_id: 'scams_fraud.romance_scam',
        severity: 'P1',
        reason: 'decision',
        requested_by: { type: 'member', id: 'mem_01H' },
      },
    })
  })

  it('fills nulls for a threshold action without a case', () => {
    const e: InternalEvent = {
      type: 'action.requested',
      actionRequestId: 'acr_2',
      actionKey: 'hide_content',
      subjectExternalId: 'u_5531',
      reason: 'threshold',
      requestedBy: { type: 'system', id: 'scoring' },
    }
    expect(toWebhook(e, ctx)?.data).toEqual({
      action_request_id: 'acr_2',
      action_key: 'hide_content',
      subject_external_id: 'u_5531',
      case_id: null,
      decision_id: null,
      category_id: null,
      severity: null,
      reason: 'threshold',
      requested_by: { type: 'system', id: 'scoring' },
    })
  })

  it('carries notice text but never the email', () => {
    const managed: InternalEvent = {
      type: 'decision.notice',
      decisionId: 'dec_1',
      recipient: 'reported',
      subjectExternalId: 'u_5531',
      locale: 'en',
      text: 'Your account is suspended for 7 days for asking a match for money.',
      appealUrl: 'https://appeal.flagwise.dev/a/xyz',
      email: 'b@example.com',
    }
    expect(toWebhook(managed, ctx)?.data).toEqual({
      decision_id: 'dec_1',
      recipient: 'reported',
      subject_external_id: 'u_5531',
      locale: 'en',
      text: 'Your account is suspended for 7 days for asking a match for money.',
      appeal_url: 'https://appeal.flagwise.dev/a/xyz',
      appeal_deadline: null,
    })
    expect(JSON.stringify(toWebhook(managed, ctx))).not.toContain('b@example.com')
    const webhookMode: InternalEvent = { ...managed, appealUrl: null, appealDeadline: new Date('2027-05-03T09:00:00.000Z') }
    delete (webhookMode as { email?: string }).email
    expect(toWebhook(webhookMode, ctx)?.data).toMatchObject({ appeal_url: null, appeal_deadline: '2027-05-03T09:00:00.000Z' })
  })

  it.each<[InternalEvent, string, Record<string, unknown>]>([
    [
      { type: 'account.threshold_crossed', subjectExternalId: 'u_1', score: 120, threshold: 100, actionKey: 'ban', autoRequested: false },
      'account.threshold_crossed',
      { subject_external_id: 'u_1', score: 120, threshold: 100, action_key: 'ban', auto_requested: false },
    ],
    [
      { type: 'appeal.filed', appealId: 'apl_1', decisionId: 'dec_1', appellant: 'reported', text: 'I was joking' },
      'appeal.filed',
      { appeal_id: 'apl_1', decision_id: 'dec_1', appellant: 'reported' },
    ],
    [
      { type: 'appeal.resolved', appealId: 'apl_1', outcome: 'overturned', reverseActionRequestIds: ['acr_9'] },
      'appeal.resolved',
      { appeal_id: 'apl_1', outcome: 'overturned', reverse_action_request_ids: ['acr_9'] },
    ],
    [
      { type: 'identifier.matched', subjectExternalId: 'u_new', matchedExternalId: 'u_old', priorScore: 130, categories: ['scams_fraud'], crossApp: true },
      'identifier.matched',
      { subject_external_id: 'u_new', matched_external_id: 'u_old', prior_score: 130, categories: ['scams_fraud'], cross_app: true },
    ],
    [
      { type: 'subject.erased', erasureId: 'ers_1', subjectExternalId: 'u_5531', heldItems: 2 },
      'subject.erased',
      { erasure_id: 'ers_1', subject_external_id: 'u_5531', held_items: 2 },
    ],
  ])('maps %o', (event, type, data) => {
    expect(toWebhook(event, ctx)).toEqual({ ...envelope, type, data })
  })

  it.each(['case.opened', 'case.claimed', 'case.released'] as const)('does not expose %s', (type) => {
    expect(toWebhook({ type, caseId: 'case_1' }, ctx)).toBeNull()
  })

  it('copies livemode and app from the context', () => {
    const e: InternalEvent = { type: 'subject.erased', erasureId: 'ers_1', subjectExternalId: 'u', heldItems: 0 }
    expect(toWebhook(e, { ...ctx, livemode: false, appId: 'app_test' })).toMatchObject({ livemode: false, app_id: 'app_test' })
  })

  it.each([
    { eventId: 'msg_1' },
    { eventId: '' },
    { apiVersion: '2026-11' },
    { apiVersion: 'v1' },
  ])('rejects context %o', (patch) => {
    const e: InternalEvent = { type: 'subject.erased', erasureId: 'ers_1', subjectExternalId: 'u', heldItems: 0 }
    expect(() => toWebhook(e, { ...ctx, ...patch })).toThrow(RangeError)
  })
})

describe('matchesFilter', () => {
  it('matches everything without a filter', () => {
    expect(matchesFilter('report.triaged', null)).toBe(true)
    expect(matchesFilter('report.triaged', [])).toBe(true)
  })

  it('matches only listed types', () => {
    expect(matchesFilter('action.requested', ['action.requested', 'appeal.filed'])).toBe(true)
    expect(matchesFilter('report.triaged', ['action.requested'])).toBe(false)
  })
})
