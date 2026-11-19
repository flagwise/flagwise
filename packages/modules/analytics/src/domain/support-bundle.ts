// The "Send to support" bundle. Flagwise staff never see tenant data unless the tenant sends it, so
// the bundle carries ids, states and technical facts, and evidence only when the tenant ticks the box.

export interface SupportInput {
  readonly flagwiseVersion: string
  readonly caseId: string
  readonly appId: string
  readonly traceId: string
  readonly timeline: readonly {
    readonly at: Date
    readonly type: string
    readonly state?: string
    readonly actorName?: string
    readonly actorEmail?: string
    readonly note?: string
  }[]
  readonly classification: {
    readonly model: string
    readonly promptVersion: string
    readonly confidence: number
    readonly signals: readonly string[]
    readonly classifiedBy: 'llm' | 'rules'
    readonly summary?: string
  } | null
  readonly triageRules: readonly { readonly rule: string; readonly inputs: Readonly<Record<string, string | number | boolean | null>> }[]
  readonly webhookAttempts: readonly { readonly at: Date; readonly status: number | null; readonly latencyMs: number; readonly url?: string }[]
  readonly tenantNote: string
  readonly evidence?: unknown
}

export interface SupportBundle {
  readonly bundle_version: 1
  readonly flagwise_version: string
  readonly case_id: string
  readonly app_id: string
  readonly trace_id: string
  readonly timeline: readonly { readonly at: string; readonly type: string; readonly state?: string }[]
  readonly classification: {
    readonly model: string
    readonly prompt_version: string
    readonly confidence: number
    readonly signals: readonly string[]
    readonly classified_by: 'llm' | 'rules'
  } | null
  readonly triage_rules: readonly { readonly rule: string; readonly inputs: Readonly<Record<string, string | number | boolean | null>> }[]
  readonly webhook_attempts: readonly { readonly at: string; readonly status: number | null; readonly latency_ms: number }[]
  readonly tenant_note: string
  readonly eval_set_opt_in: boolean
  readonly evidence?: unknown
  readonly truncated_events: number
}

/**
 * Builds the bundle, keys in this order: bundle_version 1, flagwise_version, case_id, app_id,
 * trace_id, timeline (`{ at, type, state? }`, by time, stable), classification (or null),
 * triage_rules, webhook_attempts (`{ at, status, latency_ms }`), tenant_note (trimmed, at most 2000
 * characters, else RangeError), eval_set_opt_in, evidence (`input.evidence ?? null`, only when
 * includeEvidence), truncated_events. Dates become ISO strings. Personal or content fields are never
 * copied: timeline actorName, actorEmail and note, the classification summary, webhook urls.
 *
 * Size: while the UTF-8 length of the JSON is above maxBytes, the oldest timeline entry is removed
 * and counted in truncated_events; still too big with an empty timeline throws a RangeError.
 */
export function buildSupportBundle(
  input: SupportInput,
  opts: { readonly includeEvidence: boolean; readonly joinEvalSet: boolean },
  maxBytes = 1_000_000,
): { bundle: SupportBundle; truncated: boolean } {
  const note = input.tenantNote.trim()
  if (note.length > 2000) throw new RangeError('Tenant note is longer than 2000 characters')

  const timeline = input.timeline
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i)
    .map(({ e }) => ({ at: e.at.toISOString(), type: e.type, ...(e.state !== undefined ? { state: e.state } : {}) }))

  const build = (dropped: number): SupportBundle => ({
    bundle_version: 1,
    flagwise_version: input.flagwiseVersion,
    case_id: input.caseId,
    app_id: input.appId,
    trace_id: input.traceId,
    timeline: timeline.slice(dropped),
    classification: input.classification && {
      model: input.classification.model,
      prompt_version: input.classification.promptVersion,
      confidence: input.classification.confidence,
      signals: input.classification.signals,
      classified_by: input.classification.classifiedBy,
    },
    triage_rules: input.triageRules,
    webhook_attempts: input.webhookAttempts.map((a) => ({ at: a.at.toISOString(), status: a.status, latency_ms: a.latencyMs })),
    tenant_note: note,
    eval_set_opt_in: opts.joinEvalSet,
    ...(opts.includeEvidence ? { evidence: input.evidence ?? null } : {}),
    truncated_events: dropped,
  })

  const size = (b: SupportBundle) => new TextEncoder().encode(JSON.stringify(b)).length
  let dropped = 0
  let bundle = build(dropped)
  while (size(bundle) > maxBytes) {
    if (dropped >= timeline.length) throw new RangeError('Bundle is too large even without a timeline')
    dropped++
    bundle = build(dropped)
  }
  return { bundle, truncated: dropped > 0 }
}
