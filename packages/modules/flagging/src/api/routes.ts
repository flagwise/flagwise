// The flagging routes. The edge authenticates the API key, sets the tenant context and maps thrown
// FlagwiseErrors to problem+json; these routes authorize from the context and call the use cases.

import { can, FlagwiseError, type TenantContext, type TenantRef } from '@flagwise/kernel'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ReportSnapshot } from '@flagwise/contracts'
import { getEvidence, getReport, submitReport, type FlaggingDeps, type Report } from '../app/reports.ts'
import { MAX_REPORT_BYTES } from '../domain/validate-report.ts'

export interface FlaggingEnv {
  Variables: { tenant: TenantContext }
}

/**
 * `POST /flagging/reports` (202) and `GET /flagging/reports/:id` (200), for API keys with the `flagging` scope ('forbidden'
 * otherwise). POST takes the optional `Idempotency-Key` header; a replay answers with the first
 * response and `Idempotent-Replayed: true`.
 *
 * `GET /flagging/reports/:id/evidence` (200), for callers allowed `case.work` (moderators; API keys with the
 * `admin` scope): what the report says, from its snapshot. Contact emails and identifier hashes
 * are left out; the evidence package (F20) carries the full snapshot.
 */
export function flaggingRoutes(deps: FlaggingDeps): Hono<FlaggingEnv> {
  const routes = new Hono<FlaggingEnv>().basePath('/flagging')

  routes.post(
    '/reports',
    // Stops reading a larger body early; submitReport checks the size again.
    bodyLimit({
      maxSize: MAX_REPORT_BYTES,
      onError: () => {
        throw new FlagwiseError('payload_too_large', 'Payload exceeds 64 KB', { errors: [{ path: '', message: 'Payload exceeds 64 KB' }] })
      },
    }),
    async (c) => {
      const tenant = flaggingTenant(c.get('tenant'))
      const { report, replayed } = await submitReport(deps, {
        tenant,
        body: await c.req.text(),
        idempotencyKey: c.req.header('idempotency-key'),
      })
      // The first response, again on a replay: the report as it was received.
      return c.json(reportBody(report, { asReceived: true }), 202, replayed ? { 'idempotent-replayed': 'true' } : {})
    },
  )

  routes.get('/reports/:id', async (c) => {
    const tenant = flaggingTenant(c.get('tenant'))
    return c.json(reportBody(await getReport(deps, tenant, c.req.param('id')), { asReceived: false }))
  })

  routes.get('/reports/:id/evidence', async (c) => {
    const ctx = c.get('tenant')
    if (!ctx.appId || !can(ctx, { action: 'case.work', appId: ctx.appId })) {
      throw new FlagwiseError('forbidden', 'This API key does not have the admin scope')
    }
    const tenant = { orgId: ctx.orgId, appId: ctx.appId, livemode: ctx.livemode }
    return c.json(evidenceBody(await getEvidence(deps, tenant, c.req.param('id'))))
  })

  return routes
}

function evidenceBody(s: ReportSnapshot) {
  const party = (p: ReportSnapshot['report']['reporter']) => ({ external_id: p.externalId, account_created_at: p.accountCreatedAt ?? null, locale: p.locale ?? null })
  const { report } = s
  return {
    object: 'evidence',
    report_id: s.report_id,
    received_at: s.received_at,
    reporter: party(report.reporter),
    reported: party(report.reported),
    category: report.category,
    text: report.text ?? null,
    evidence: {
      kind: report.evidence.kind,
      author_id: report.evidence.authorId ?? null,
      content: report.evidence.content.map((i) => ({ text: i.text, author: i.author ?? null, at: i.at ?? null })),
      media: report.evidence.media,
      metadata: report.evidence.metadata,
    },
  }
}

/** The key's app and mode, when the caller may use the flagging endpoints of its app. */
function flaggingTenant(ctx: TenantContext): TenantRef {
  if (!ctx.appId || !can(ctx, { action: 'report.create', appId: ctx.appId })) {
    throw new FlagwiseError('forbidden', 'This API key does not have the flagging scope')
  }
  return { orgId: ctx.orgId, appId: ctx.appId, livemode: ctx.livemode }
}

/**
 * The report as the API shows it: `status` is 'received' until the cases module has put it in a
 * case, then 'assigned' with `case_id` and `joined_existing_case`.
 */
function reportBody(r: Report, opts: { readonly asReceived: boolean }) {
  const assigned = !opts.asReceived && r.caseId !== null
  return {
    id: r.id,
    object: 'report',
    status: assigned ? 'assigned' : 'received',
    case_id: assigned ? r.caseId : null,
    ...(assigned && { joined_existing_case: r.joinedExistingCase }),
    livemode: r.tenant.livemode,
    received_at: r.receivedAt.toISOString(),
  }
}
