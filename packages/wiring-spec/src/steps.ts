// What the tenant's app and its moderators do, as steps the scenarios share.

import { eventually, type Install, type Member } from './install.ts'
import { PATHS } from './paths.ts'
import type { Webhook } from './net.ts'

export interface ReportInput {
  readonly reported: string
  readonly category?: string
  readonly text?: string
  readonly reporter?: string
}

/** Files a report from the tenant's backend and returns its id. */
export async function fileReport(i: Install, input: ReportInput): Promise<string> {
  const res = await i.call(i.flaggingKey, PATHS.reports(), {
    method: 'POST',
    body: {
      reporter: { external_id: input.reporter ?? 'u_jane_doe' },
      reported: { external_id: input.reported },
      category: input.category ?? 'scams_fraud',
      evidence: { kind: 'message', content: [input.text ?? 'Send me $200 and I will double it'] },
    },
  })
  if (res.status !== 202 && res.status !== 201) throw new Error(`Filing a report answered ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body.id as string
}

/** The case a report ended up in, once it has one. */
export function caseOf(i: Install, reportId: string): Promise<string> {
  return eventually(async () => ((await i.call(i.flaggingKey, PATHS.report(reportId))).body?.case_id as string | null) ?? undefined, `a case for ${reportId}`)
}

/** The case as a moderator sees it, once `check` holds. */
export function caseWhen(i: Install, caseId: string, check: (c: Record<string, any>) => boolean, what = 'the case state'): Promise<Record<string, any>> {
  return eventually(async () => {
    const res = await i.call(i.jane.key, PATHS.case(caseId))
    return res.status === 200 && check(res.body) ? (res.body as Record<string, any>) : undefined
  }, `${caseId}: ${what}`)
}

/** Files a report and returns its case once triage is done (open or untriaged). */
export async function triagedCase(i: Install, input: ReportInput): Promise<Record<string, any>> {
  const reportId = await fileReport(i, input)
  const caseId = await caseOf(i, reportId)
  const c = await caseWhen(i, caseId, (c) => c.state === 'open' || c.state === 'untriaged', 'triaged')
  return { ...c, reportId }
}

export async function claim(i: Install, member: Member, caseId: string): Promise<Record<string, any>> {
  const res = await i.call(member.key, PATHS.claim(caseId), { method: 'POST' })
  if (res.status !== 200) throw new Error(`Claiming ${caseId} answered ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body
}

/** The webhooks of `type` received so far, once there are at least `count`. */
export function webhooksOf(i: Install, type: string, match: (w: Webhook) => boolean = () => true, count = 1): Promise<readonly Webhook[]> {
  return eventually(() => {
    const found = i.net.webhooks().filter((w) => w.type === type && match(w))
    return found.length >= count ? found : undefined
  }, `${count} ${type} webhook(s)`)
}

export const ACTION_KEYS = [
  { key: 'warn', label: { en: 'Warn' }, categories: ['*'] },
  { key: 'suspend_7d', label: { en: 'Suspend 7 days' }, categories: ['scams_fraud'] },
  { key: 'ban', label: { en: 'Ban' }, categories: ['*'] },
]

export async function setActionKeys(i: Install, keys: readonly unknown[] = ACTION_KEYS): Promise<void> {
  const res = await i.call(i.jane.key, PATHS.actionKeys(), { method: 'PUT', body: { data: keys } })
  if (res.status !== 200) throw new Error(`Setting action keys answered ${res.status}: ${JSON.stringify(res.body)}`)
}
