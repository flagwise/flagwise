// Every route, event name and webhook type the scenarios use, in one place. Renaming a service or
// an event changes this file and nothing else, so the scenarios keep guarding the same behaviour.

/** Public API routes, below /v1. */
export const PATHS = {
  reports: () => '/reports',
  report: (id: string) => `/reports/${id}`,
  cases: () => '/cases',
  case: (id: string) => `/cases/${id}`,
  claim: (id: string) => `/cases/${id}/claim`,
  decision: (id: string) => `/cases/${id}/decision`,
  retryActions: (id: string) => `/cases/${id}/actions/retry`,
  classification: (id: string) => `/cases/${id}/classification`,
  actionRequest: (id: string) => `/action-requests/${id}`,
  confirmAction: (id: string) => `/action-requests/${id}/confirm`,
  failAction: (id: string) => `/action-requests/${id}/fail`,
  actionKeys: () => '/config/actions',
  categories: () => '/config/categories',
  llmSettings: () => '/config/llm',
  audit: (caseId: string) => `/audit?case_id=${caseId}`,
  evidence: (reportId: string) => `/reports/${reportId}/evidence`,
  erase: (externalId: string) => `/subjects/${externalId}/erase`,
  erasure: (id: string) => `/erasures/${id}`,
} as const

/** Facts on the event bus, read as a passive consumer of the contracts. */
export const EVENTS = {
  reportReceived: 'report.received.v1',
  caseOpened: 'case.opened.v1',
  reportAttached: 'case.report_attached.v1',
  caseClassified: 'case.classified.v1',
  caseReclassified: 'case.reclassified.v1',
  caseTriaged: 'case.triaged.v1',
  caseClaimed: 'case.claimed.v1',
  caseCorrected: 'case.corrected.v2',
  caseDecided: 'case.decided.v1',
  actionRequested: 'action.requested.v1',
  actionConfirmed: 'action.confirmed.v1',
  actionFailed: 'action.failed.v1',
  actionsRetried: 'case.actions_retried.v1',
  erasureRequested: 'subject.erasure_requested.v1',
  erased: 'subject.erased.v1',
} as const

/** Webhook types: the tenant's public contract, which phase 1 does not change. */
export const WEBHOOKS = {
  reportTriaged: 'report.triaged',
  actionRequested: 'action.requested',
  subjectErased: 'subject.erased',
} as const
