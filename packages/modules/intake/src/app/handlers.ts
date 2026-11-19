// Intake learns which case each report went to from moderation's events, so GET /v1/reports/{id}
// can show it. Both events are handled on their own and only the first answer per report counts,
// so order and redelivery do not matter. It also erases an account's reports when asked.

import { currentType, erasedId, erasureAnswer, type EventData } from '@flagwise/contracts'
import { tenantOf, type EventBus } from '@flagwise/platform'
import { eraseAccount, recordReportCase, type IntakeDeps } from './reports.ts'

/**
 * Subscribes intake's groups:
 * - 'intake.cases': case.opened and case.report_attached -> recordReportCase.
 * - 'intake.erasure': subject.erasure_requested -> eraseAccount, answering erased, or nothing_held
 *   when the account has no report.
 */
export function subscribeIntake(bus: EventBus, intake: Pick<IntakeDeps, 'run' | 'storage' | 'clock'>): void {
  bus.subscribe('intake.erasure', [currentType('subject.erasure_requested')], async (event) => {
    const tenant = tenantOf(event)
    const request = event.data as EventData<'subject.erasure_requested.v1'>
    await intake.run(tenant, async (tx) => {
      const had = await eraseAccount(intake, tx, tenant, request.subjectExternalId, erasedId(request.erasureId))
      await tx.publish(erasureAnswer(request, 'intake.erasure', had > 0 ? 'erased' : 'nothing_held', intake.clock.now()))
    })
  })

  bus.subscribe('intake.cases', ['case.opened.v1', 'case.report_attached.v1'], async (event) => {
    const { caseId, reportId } = event.data as EventData<'case.opened.v1'>
    await recordReportCase(intake, { tenant: tenantOf(event), reportId, caseId, joinedExistingCase: event.type === 'case.report_attached.v1' })
  })
}
