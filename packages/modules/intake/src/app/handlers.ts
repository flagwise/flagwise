// Intake learns which case each report went to from moderation's events, so GET /v1/reports/{id}
// can show it. Both events are handled on their own and only the first answer per report counts,
// so order and redelivery do not matter.

import type { EventData } from '@flagwise/contracts'
import { tenantOf, type EventBus } from '@flagwise/platform'
import { recordReportCase, type IntakeDeps } from './reports.ts'

/** Subscribes group 'intake.cases': case.opened and case.report_attached -> recordReportCase. */
export function subscribeIntake(bus: EventBus, intake: Pick<IntakeDeps, 'run'>): void {
  bus.subscribe('intake.cases', ['case.opened.v1', 'case.report_attached.v1'], async (event) => {
    const { caseId, reportId } = event.data as EventData<'case.opened.v1'>
    await recordReportCase(intake, { tenant: tenantOf(event), reportId, caseId, joinedExistingCase: event.type === 'case.report_attached.v1' })
  })
}
