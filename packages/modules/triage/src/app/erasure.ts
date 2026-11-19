// What erasing an account does to triage's record of a case, as a pure change, for stores that
// keep records as they are (the Postgres store does the same on its stored form).

import type { TriageCase } from './ports.ts'

/**
 * The case with the account erased, or null when the account is not in it: as the reported
 * account, its id becomes `erasedId` and every report loses the reported account's age; as a
 * reporter, its id becomes `erasedId` and its own account age is dropped.
 */
export function erasedFromCase(r: TriageCase, externalId: string, erasedId: string): TriageCase | null {
  const reported = r.subjectExternalId === externalId
  if (!reported && !r.reports.some((x) => x.reporterExternalId === externalId)) return null
  return {
    ...r,
    ...(reported && { subjectExternalId: erasedId }),
    reports: r.reports.map((x) => ({
      ...x,
      ...(x.reporterExternalId === externalId && { reporterExternalId: erasedId, reporterAccountCreatedAt: null }),
      ...(reported && { reportedAccountCreatedAt: null }),
    })),
  }
}
