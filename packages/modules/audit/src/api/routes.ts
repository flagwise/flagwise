// The audit routes: search an app's audit log and verify its hash chain. The edge authenticates
// and sets the caller; these routes authorize from it and call the use cases.

import { can, FlagwiseError, type FieldError, type Caller, type AppRef } from '@flagwise/kernel'
import { Hono } from 'hono'
import type { AuditPage, AuditQuery, AuditVerification } from '../app/audit-log.ts'
import type { AuditEntry } from '../domain/chain.ts'

export interface AuditEnv {
  Variables: { caller: Caller }
}

export interface AuditRoutesDeps {
  /** Searches the caller's chain in an app transaction. */
  search(appRef: AppRef, query: AuditQuery): Promise<AuditPage>
  /** verifyAuditLog in an app transaction. */
  verify(appRef: AppRef): Promise<AuditVerification>
}

const MAX_ID = 128

/**
 * For callers allowed `audit.read` on the app (API keys with the `admin` scope; 'forbidden'
 * otherwise), mounted at `/audit`, on the caller's app and mode:
 *
 * - `GET /audit/entries`: entries in the order they were written. Filters, each optional: `actor_id`,
 *   `case_id` (the case's timeline), `subject_external_id` (the reported account), `from` and `to`
 *   (RFC 3339; from inclusive, to exclusive); `limit` 1 to 100 (default 50) and `cursor`. Answers
 *   `{ object: 'list', data, next_cursor }`.
 * - `GET /audit/verify`: `{ object: 'audit_verification', ok, checked }`, plus `seq` and `reason`
 *   (`seq_gap`, `prev_mismatch`, `pii_mismatch`, `hash_mismatch`) of the first broken entry.
 *
 * Each entry: `{ object: 'audit_entry', seq, at, actor: { type, id }, action, target: { type, id },
 * facts, pii, pii_digest, prev_hash, hash }`; `hash` is the lowercase hex SHA-256 of `prev_hash`, a
 * newline and the canonical JSON of `{ seq, at, actor, action, target, facts, piiDigest }`. Bad
 * filters are 'validation_failed' with field errors.
 */
export function auditRoutes(deps: AuditRoutesDeps): Hono<AuditEnv> {
  const routes = new Hono<AuditEnv>().basePath('/audit')

  routes.get('/verify', async (c) => {
    const result = await deps.verify(reader(c.get('caller')))
    return c.json({ object: 'audit_verification', ...result })
  })

  routes.get('/entries', async (c) => {
    const appRef = reader(c.get('caller'))
    const page = await deps.search(appRef, auditQuery(c.req.query()))
    return c.json({ object: 'list', data: page.data.map(entryBody), next_cursor: page.nextAfterSeq === null ? null : String(page.nextAfterSeq) })
  })

  return routes
}

function reader(ctx: Caller): AppRef {
  if (!ctx.appId || !can(ctx, { action: 'audit.read', appId: ctx.appId })) throw new FlagwiseError('forbidden', 'This API key does not have the admin scope')
  return { appId: ctx.appId, livemode: ctx.livemode }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function auditQuery(params: Record<string, string>): AuditQuery {
  const errors: FieldError[] = []
  const id = (name: string) => {
    const v = params[name]
    if (v === undefined) return undefined
    if (v === '' || v.length > MAX_ID) errors.push({ path: name, message: `An id of 1 to ${MAX_ID} characters` })
    return v
  }
  const time = (name: string) => {
    const v = params[name]
    if (v === undefined) return undefined
    const d = new Date(v)
    if (!RFC3339.test(v) || Number.isNaN(d.getTime())) errors.push({ path: name, message: 'An RFC 3339 timestamp' })
    return d
  }
  const actorId = id('actor_id')
  const caseId = id('case_id')
  const subjectExternalId = id('subject_external_id')
  const from = time('from')
  const to = time('to')
  let limit = 50
  if (params.limit !== undefined) {
    limit = Number(params.limit)
    if (!/^\d+$/.test(params.limit) || limit < 1 || limit > 100) errors.push({ path: 'limit', message: 'A whole number from 1 to 100' })
  }
  let afterSeq: number | undefined
  if (params.cursor !== undefined) {
    afterSeq = Number(params.cursor)
    if (!/^\d{1,15}$/.test(params.cursor)) errors.push({ path: 'cursor', message: 'A cursor from next_cursor' })
  }
  if (errors.length) throw new FlagwiseError('validation_failed', 'The audit filters are not valid', { errors })
  return {
    limit,
    ...(actorId !== undefined && { actorId }),
    ...(caseId !== undefined && { caseId }),
    ...(subjectExternalId !== undefined && { subjectExternalId }),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(afterSeq !== undefined && { afterSeq }),
  }
}

function entryBody(e: AuditEntry) {
  return {
    object: 'audit_entry',
    seq: e.seq,
    at: e.at,
    actor: e.actor,
    action: e.action,
    target: e.target,
    facts: e.facts,
    pii: e.pii,
    pii_digest: e.piiDigest,
    prev_hash: e.prevHash,
    hash: e.hash,
  }
}
