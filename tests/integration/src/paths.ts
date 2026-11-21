// Every route and webhook type the scenarios use, in one place. Renaming a service or a route
// changes this file and nothing else, so the scenarios keep guarding the same behaviour.

/** Public API routes, below /v1. */
export const PATHS = {
  reports: () => '/flagging/reports',
  report: (id: string) => `/flagging/reports/${id}`,
  cases: () => '/moderation/cases',
  case: (id: string) => `/moderation/cases/${id}`,
  claim: (id: string) => `/moderation/cases/${id}/claim`,
  decision: (id: string) => `/moderation/cases/${id}/decision`,
  retryActions: (id: string) => `/moderation/cases/${id}/actions/retry`,
  classification: (id: string) => `/classify/classifications/${id}`,
  actionRequest: (id: string) => `/delivery/action-requests/${id}`,
  confirmAction: (id: string) => `/delivery/action-requests/${id}/confirm`,
  failAction: (id: string) => `/delivery/action-requests/${id}/fail`,
  actionKeys: () => '/policy/action-keys',
  categories: () => '/policy/categories/definitions',
  llmSettings: () => '/policy/llm-settings',
  menu: (locale?: string) => `/policy/categories/menu${locale ? `?locale=${locale}` : ''}`,
  taxonomy: () => '/policy/taxonomy',
  presets: () => '/policy/presets',
  audit: (caseId: string) => `/audit/entries?case_id=${caseId}`,
  auditEntries: (query = '') => `/audit/entries${query ? `?${query}` : ''}`,
  auditVerify: () => '/audit/verify',
  evidence: (reportId: string) => `/flagging/reports/${reportId}/evidence`,
  erase: (externalId: string) => `/privacy/subjects/${externalId}/erase`,
  erasure: (id: string) => `/privacy/erasures/${id}`,
  notifications: (states?: string) => `/notifications/notifications${states ? `?state=${states}` : ''}`,
  acknowledge: (id: string) => `/notifications/notifications/${id}/acknowledge`,
} as const

/** Webhook types: the tenant's public contract. */
export const WEBHOOKS = {
  reportTriaged: 'report.triaged',
  actionRequested: 'action.requested',
  subjectErased: 'subject.erased',
} as const
