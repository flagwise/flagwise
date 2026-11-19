// The classification route: how a case was classified, with the LLM summary. The summary is derived
// from evidence, so it is served here, by the module that wrote it, and never copied elsewhere.

import { can, FlagwiseError, type TenantContext } from '@flagwise/kernel'
import { Hono } from 'hono'
import { findClassification } from '../app/classify-case.ts'
import type { ClassificationRecord, ClassifyDeps } from '../app/ports.ts'

export interface ClassifyEnv {
  Variables: { tenant: TenantContext }
}

/**
 * `GET /classify/classifications/:caseId`, for callers allowed `case.work` on the app ('forbidden'
 * otherwise); 'not_found' when the case has no classification (yet), or does not exist.
 * Usage, model and prompt details stay internal.
 */
export function classifyRoutes(deps: Pick<ClassifyDeps, 'run'>): Hono<ClassifyEnv> {
  const routes = new Hono<ClassifyEnv>().basePath('/classify')
  routes.get('/classifications/:caseId', async (c) => {
    const ctx = c.get('tenant')
    if (!ctx.appId || !can(ctx, { action: 'case.work', appId: ctx.appId })) {
      throw new FlagwiseError('forbidden', 'This API key does not have the admin scope')
    }
    const tenant = { appId: ctx.appId, livemode: ctx.livemode }
    const record = await findClassification(deps, tenant, c.req.param('caseId'))
    if (!record) throw new FlagwiseError('not_found', 'This case has no classification yet')
    return c.json(classificationBody(record))
  })
  return routes
}

function classificationBody(r: ClassificationRecord) {
  return {
    object: 'classification',
    case_id: r.caseId,
    report_id: r.reportId,
    classified_by: r.classifiedBy,
    rules_reason: r.rulesReason,
    category_id: r.categoryId,
    custom_category_id: r.customCategoryId,
    confidence: r.confidence,
    low_confidence: r.lowConfidence,
    signals: r.signals,
    summary: r.summary,
    injection_suspected: r.injectionSuspected,
    escalated: r.escalated,
    classified_at: r.classifiedAt.toISOString(),
  }
}
