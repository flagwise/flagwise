// The case routes: the queue, one case, and working it (claim, release, decide). The edge
// authenticates, sets the tenant context and maps thrown FlagwiseErrors to problem+json; these
// routes authorize from the context and call the use cases. They serve only the cases module's
// own data: the summary and the evidence come from the classify and flagging routes.

import { can, FlagwiseError, type Clock, type FieldError, type TenantContext, type TenantRef } from '@flagwise/kernel'
import { Hono, type Context } from 'hono'
import { CASE_STATES, type CaseState } from '../domain/case-state.ts'
import { CaseChangedError, type CaseOrder, type CaseQuery, type CaseReader, type CaseRecord, type Decision, type Severity } from '../app/ports.ts'
import { CaseWorkError, type CaseRef, type CorrectInput, type DecideInput, type RetryActionsInput } from '../app/work-case.ts'

export interface ModerationEnv {
  Variables: { tenant: TenantContext }
}

export interface ModerationRoutesDeps {
  /** Runs `fn` in a tenant transaction. */
  read<T>(tenant: TenantRef, fn: (cases: CaseReader) => Promise<T>): Promise<T>
  /** claimCase, releaseCase and decideCase, each with its events published in the same transaction. */
  claim(input: CaseRef): Promise<CaseRecord>
  release(input: CaseRef & { readonly force?: boolean }): Promise<CaseRecord>
  decide(input: DecideInput): Promise<Decision>
  correct(input: CorrectInput): Promise<CaseRecord>
  retryActions(input: RetryActionsInput): Promise<CaseRecord>
  readonly clock: Clock
}

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']
const MAX_REASON = 2_000

/**
 * For callers allowed `case.work` on the app (API keys with the `admin` scope; 'forbidden'
 * otherwise). The caller's id (the API key's, or the member's) is who claims and decides.
 *
 * - `GET /moderation/cases`: the queue, most urgent first. Filters, each optional and comma-separated where
 *   it takes several values: `state` (default untriaged, open, claimed), `severity`, `category_id`,
 *   `claimed_by` (an actor id, or `none`), `sla_breached` (`true` / `false`),
 *   `subject_external_id` (an account's cases: with every state listed in `state`, its history);
 *   `order` (`urgency`, the default, or `recent`: latest opened first); `limit` 1 to 100
 *   (default 50) and `cursor` (from a page of the same order). Answers
 *   `{ object: 'list', data, next_cursor }`.
 * - `GET /moderation/cases/:id`: the case, or 'not_found'. A triaged case lists the triage rules that
 *   applied (`applied_rules`, such as `reported_new_account`) and its `flags` (such as
 *   `reported_age_unknown`); both are empty before triage.
 * - `POST /moderation/cases/:id/claim`, `POST /moderation/cases/:id/release` (body `{ "force": true }` to release
 *   someone else's claim, App Admins only): the case after the change.
 * - `PATCH /moderation/cases/:id`: correct a claimed case before deciding it, or triage one claimed from
 *   untriaged by hand. Body: `category_id` and/or `severity`; triage triages it again. A P0 case
 *   cannot be lowered. The case after the change: its new severity at once, its priority and SLA
 *   once triage has answered.
 * - `POST /moderation/cases/:id/decision` (201): the decision. Body: `outcome`, `category_id`, `severity`,
 *   `action_keys` (default []), optional `report_ids` (the reports shown to the moderator; default
 *   all of the case's), `public_reason` and `internal_note` (each at most 2,000 characters).
 * - `POST /moderation/cases/:id/actions/retry`: answer the failed actions of a case in action_failed. Body:
 *   `action_keys` (the same key retries it, another key replaces it, [] accepts the failures).
 *   The case after the change.
 *
 * A case in the wrong state, claimed by someone else, not claimed by the caller or already decided
 * is 'conflict' (409) with the reason in the detail; a decision the case's category does not allow
 * is 'validation_failed' (422), and so are report_ids not in the case and a correction that
 * does not stand. Bad filters or a bad body are 'validation_failed' with field errors;
 * a body that is not JSON is 'invalid_request'.
 */
export function moderationRoutes(deps: ModerationRoutesDeps): Hono<ModerationEnv> {
  const routes = new Hono<ModerationEnv>().basePath('/moderation')

  routes.get('/cases', async (c) => {
    const { tenant } = caseWork(c.get('tenant'))
    const query = queueQuery(c, deps.clock.now())
    const page = await deps.read(tenant, (cases) => cases.list(tenant, query)).catch((err: unknown) => {
      // The reader refuses a cursor it cannot decode, or one from a page of the other order.
      if (err instanceof RangeError) throw new FlagwiseError('validation_failed', 'The queue filters are not valid', { errors: [{ path: 'cursor', message: 'Not a valid cursor' }] })
      throw err
    })
    return c.json({ object: 'list', data: page.data.map(caseBody), next_cursor: page.nextCursor })
  })

  routes.get('/cases/:id', async (c) => {
    const { tenant } = caseWork(c.get('tenant'))
    const record = await deps.read(tenant, (cases) => cases.findById(tenant, c.req.param('id')))
    if (!record) throw new FlagwiseError('not_found', 'No such case')
    return c.json(caseBody(record))
  })

  routes.post('/cases/:id/claim', async (c) => {
    const { tenant, actorId } = caseWork(c.get('tenant'))
    return c.json(caseBody(await working(() => deps.claim({ tenant, caseId: c.req.param('id'), memberId: actorId }))))
  })

  routes.post('/cases/:id/release', async (c) => {
    const ctx = c.get('tenant')
    const { tenant, actorId } = caseWork(ctx)
    const body = await jsonBody(c, true)
    const errors: FieldError[] = []
    const force = optionalBoolean(body, 'force', errors)
    if (errors.length) throw new FlagwiseError('validation_failed', 'The release is not valid', { errors })
    if (force && !can(ctx, { action: 'policy.configure', appId: tenant.appId })) {
      throw new FlagwiseError('forbidden', "Only an App Admin can release someone else's claim")
    }
    return c.json(caseBody(await working(() => deps.release({ tenant, caseId: c.req.param('id'), memberId: actorId, ...(force && { force }) }))))
  })

  routes.post('/cases/:id/decision', async (c) => {
    const { tenant, actorId } = caseWork(c.get('tenant'))
    const input = decideInput(await jsonBody(c, false))
    const decision = await working(() => deps.decide({ tenant, caseId: c.req.param('id'), memberId: actorId, ...input }))
    return c.json(decisionBody(decision), 201)
  })

  routes.patch('/cases/:id', async (c) => {
    const { tenant, actorId } = caseWork(c.get('tenant'))
    const input = correctInput(await jsonBody(c, false))
    return c.json(caseBody(await working(() => deps.correct({ tenant, caseId: c.req.param('id'), memberId: actorId, ...input }))))
  })

  routes.post('/cases/:id/actions/retry', async (c) => {
    const { tenant, actorId } = caseWork(c.get('tenant'))
    const body = await jsonBody(c, false)
    const actionKeys = body.action_keys
    if (!isKeyList(actionKeys)) {
      throw new FlagwiseError('validation_failed', 'The retry is not valid', { errors: [{ path: 'action_keys', message: 'A list of action keys' }] })
    }
    return c.json(caseBody(await working(() => deps.retryActions({ tenant, caseId: c.req.param('id'), memberId: actorId, actionKeys }))))
  })

  return routes
}

const isKeyList = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === 'string' && k !== '')

/** The app, mode and actor of a caller allowed to work its app's cases. */
function caseWork(ctx: TenantContext): { tenant: TenantRef; actorId: string } {
  if (!ctx.appId || !can(ctx, { action: 'case.work', appId: ctx.appId })) {
    throw new FlagwiseError('forbidden', 'This API key does not have the admin scope')
  }
  const { actor } = ctx
  const actorId = actor.type === 'member' || actor.type === 'api_key' ? actor.id : actor.type === 'embed' ? `embed:${actor.sub}` : 'system'
  return { tenant: { orgId: ctx.orgId, appId: ctx.appId, livemode: ctx.livemode }, actorId }
}

/** Runs a case-work use case, turning its refusals into API errors. */
async function working<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CaseChangedError) throw new FlagwiseError('conflict', 'The case kept changing; try again')
    if (!(err instanceof CaseWorkError)) throw err
    switch (err.code) {
      case 'not_found':
        throw new FlagwiseError('not_found', 'No such case')
      case 'invalid_state':
        throw new FlagwiseError('conflict', 'The case is not in a state that allows this')
      case 'claimed_by_other':
        throw new FlagwiseError('conflict', `The case is claimed by ${err.holder}`)
      case 'not_claimed':
        throw new FlagwiseError('conflict', 'Claim the case before deciding it')
      case 'already_decided':
        throw new FlagwiseError('conflict', `The case was already decided (${err.decision?.id})`)
      case 'invalid_decision':
        throw new FlagwiseError('validation_failed', 'The decision is not allowed for this case', {
          errors: [{ path: 'action_keys', message: 'Not allowed for this category or outcome, or listed twice' }],
        })
      case 'invalid_basis':
        throw new FlagwiseError('validation_failed', 'The decision is not allowed for this case', {
          errors: [{ path: 'report_ids', message: "One or more of the case's reports, each once" }],
        })
      case 'invalid_correction':
        throw new FlagwiseError('validation_failed', 'The correction is not allowed for this case', {
          errors: [{ path: '', message: 'Unknown category, or a severity P0 rules do not allow (a P0 case is never lowered)' }],
        })
    }
  }
}

function queueQuery(c: Context, now: Date): CaseQuery {
  const errors: FieldError[] = []
  const list = (name: string) => c.req.query(name)?.split(',').map((v) => v.trim()).filter(Boolean)
  const states = list('state')
  if (states?.some((s) => !(CASE_STATES as readonly string[]).includes(s))) errors.push({ path: 'state', message: `One of ${CASE_STATES.join(', ')}` })
  const severities = list('severity')
  if (severities?.some((s) => !(SEVERITIES as readonly string[]).includes(s))) errors.push({ path: 'severity', message: 'One of P0, P1, P2' })
  const claimedBy = c.req.query('claimed_by')
  const breached = c.req.query('sla_breached')
  if (breached !== undefined && breached !== 'true' && breached !== 'false') errors.push({ path: 'sla_breached', message: 'true or false' })
  const rawLimit = c.req.query('limit')
  const limit = rawLimit === undefined ? undefined : Number(rawLimit)
  if (limit !== undefined && (!/^\d+$/.test(rawLimit!) || limit < 1 || limit > 100)) errors.push({ path: 'limit', message: 'A whole number from 1 to 100' })
  const subject = c.req.query('subject_external_id')
  if (subject !== undefined && (subject.length < 1 || subject.length > 128)) errors.push({ path: 'subject_external_id', message: '1 to 128 characters' })
  const order = c.req.query('order')
  if (order !== undefined && order !== 'urgency' && order !== 'recent') errors.push({ path: 'order', message: 'urgency or recent' })
  const cursor = c.req.query('cursor')
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) errors.push({ path: 'cursor', message: 'Not a valid cursor' })
  if (errors.length) throw new FlagwiseError('validation_failed', 'The queue filters are not valid', { errors })
  return {
    now,
    ...(states && { states: states as CaseState[] }),
    ...(severities && { severities: severities as Severity[] }),
    ...(list('category_id') && { categoryIds: list('category_id')! }),
    ...(claimedBy !== undefined && { claimedBy: claimedBy === 'none' ? null : claimedBy }),
    ...(breached !== undefined && { slaBreached: breached === 'true' }),
    ...(subject !== undefined && { subjectExternalId: subject }),
    ...(order !== undefined && { order: order as CaseOrder }),
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor }),
  }
}

async function jsonBody(c: Context, allowEmpty: boolean): Promise<Record<string, unknown>> {
  const text = await c.req.text()
  if (allowEmpty && text.trim() === '') return {}
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new FlagwiseError('invalid_request', 'The body is not valid JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FlagwiseError('validation_failed', 'The body must be a JSON object', { errors: [{ path: '', message: 'Must be an object' }] })
  }
  return body as Record<string, unknown>
}

function optionalBoolean(body: Record<string, unknown>, name: string, errors: FieldError[]): boolean | undefined {
  const v = body[name]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') errors.push({ path: name, message: 'Must be true or false' })
  return v === true
}

function decideInput(body: Record<string, unknown>): Omit<DecideInput, keyof CaseRef> {
  const errors: FieldError[] = []
  const { outcome, category_id: categoryId, severity, action_keys: actionKeys = [], report_ids: reportIds, public_reason: publicReason, internal_note: internalNote } = body
  if (outcome !== 'violation' && outcome !== 'no_violation') errors.push({ path: 'outcome', message: 'violation or no_violation' })
  if (typeof categoryId !== 'string' || categoryId.trim() === '') errors.push({ path: 'category_id', message: 'Required' })
  if (!(SEVERITIES as readonly unknown[]).includes(severity)) errors.push({ path: 'severity', message: 'One of P0, P1, P2' })
  if (!isKeyList(actionKeys)) errors.push({ path: 'action_keys', message: 'A list of action keys' })
  if (reportIds !== undefined && !isKeyList(reportIds)) errors.push({ path: 'report_ids', message: 'A list of report ids' })
  for (const [path, v] of [['public_reason', publicReason], ['internal_note', internalNote]] as const) {
    if (v !== undefined && (typeof v !== 'string' || v.length > MAX_REASON)) errors.push({ path, message: `Text of at most ${MAX_REASON} characters` })
  }
  if (errors.length) throw new FlagwiseError('validation_failed', 'The decision is not valid', { errors })
  return {
    outcome: outcome as Decision['outcome'],
    categoryId: categoryId as string,
    severity: severity as Severity,
    actionKeys: actionKeys as string[],
    ...(reportIds !== undefined && { reportIds: reportIds as string[] }),
    ...(typeof publicReason === 'string' && publicReason.trim() !== '' && { publicReason }),
    ...(typeof internalNote === 'string' && internalNote.trim() !== '' && { internalNote }),
  }
}

function correctInput(body: Record<string, unknown>): Omit<CorrectInput, keyof CaseRef> {
  const errors: FieldError[] = []
  const { category_id: categoryId, severity } = body
  if (categoryId !== undefined && (typeof categoryId !== 'string' || categoryId.trim() === '')) errors.push({ path: 'category_id', message: 'A category id' })
  if (severity !== undefined && !(SEVERITIES as readonly unknown[]).includes(severity)) errors.push({ path: 'severity', message: 'One of P0, P1, P2' })
  if (categoryId === undefined && severity === undefined) errors.push({ path: '', message: 'Give category_id, severity or both' })
  if (errors.length) throw new FlagwiseError('validation_failed', 'The correction is not valid', { errors })
  return { ...(categoryId !== undefined && { categoryId: categoryId as string }), ...(severity !== undefined && { severity: severity as Severity }) }
}

/** A case as the API shows it. */
export function caseBody(r: CaseRecord) {
  return {
    id: r.id,
    object: 'case',
    state: r.state,
    band: r.band,
    subject_external_id: r.subjectExternalId,
    opened_at: r.openedAt.toISOString(),
    report_ids: r.reportIds,
    report_count: r.reportIds.length,
    severity: r.triage?.severity ?? null,
    priority: r.triage?.priority ?? null,
    sla_due_at: r.triage?.slaDueAt.toISOString() ?? null,
    suggested_action_keys: r.triage?.suggestedActionKeys ?? [],
    applied_rules: r.triage?.applied ?? [],
    flags: r.triage?.flags ?? [],
    category_id: r.classification?.categoryId ?? null,
    custom_category_id: r.classification?.customCategoryId ?? null,
    signals: r.classification?.signals ?? [],
    injection_suspected: r.classification?.injectionSuspected ?? false,
    classified_by: r.classification?.classifiedBy ?? null,
    claim: r.claim ? { holder: r.claim.memberId, claimed_at: r.claim.claimedAt.toISOString(), last_activity_at: r.claim.lastActivityAt.toISOString() } : null,
    decision: r.decision ? decisionBody(r.decision) : null,
    livemode: r.tenant.livemode,
  }
}

function decisionBody(d: Decision) {
  return {
    id: d.id,
    object: 'decision',
    outcome: d.outcome,
    category_id: d.categoryId,
    severity: d.severity,
    action_keys: d.actionKeys,
    decided_by: d.decidedBy,
    decided_at: d.decidedAt.toISOString(),
    report_ids: d.reportIds,
    public_reason: d.publicReason ?? null,
    internal_note: d.internalNote ?? null,
  }
}
