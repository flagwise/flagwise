// The event catalog: every event type the services publish on the bus, with its owner, the semver
// of its schema and what it means. A type carries its major in its name (`case.triaged.v1`), so a
// breaking change, or a change of meaning such as a new scale, is a new type the owner publishes
// next to the old one for as long as consumers need it. A minor version adds optional fields; a
// patch only clarifies. Consumers subscribe to the majors they read and ignore fields they do not
// know; the bus checks every event against its schema before it publishes it.

import { policyActionKeySchema, policyCategorySchema, policyLlmSettingsSchema, policySchema } from '../policy.ts'
import { P0_SIGNALS } from '../taxonomy.ts'
import { id, ids, label, severity, time, z } from './schema.ts'

export interface EventSpec<N extends string = string, M extends number = number, S extends z.ZodType = z.ZodType> {
  /** The fact, without its major: `case.triaged`. */
  readonly name: N
  readonly major: M
  /** Semver of the schema; its major is the type's. */
  readonly version: string
  /** The one service that publishes it; `platform` for the bus's own facts, `any` for an answer every service may give. */
  readonly owner: string
  readonly meaning: string
  /** The data, as consumers receive it (JSON). */
  readonly schema: S
}

const spec = <const N extends string, const M extends number, S extends z.ZodType>(s: EventSpec<N, M, S>) => s

const requestedBy = z.strictObject({ type: z.enum(['member', 'api_key', 'system']), id })
const classification = {
  caseId: id,
  /** Missing on events from before it was carried. */
  reportId: id.optional(),
  categoryId: id,
  customCategoryId: id.nullable().optional(),
  signals: z.array(z.string()),
  injectionSuspected: z.boolean(),
  preRuleP0: z.boolean(),
  classifiedBy: z.enum(['llm', 'rules']),
  rulesReason: z.enum(['rules_only', 'llm_failed']).nullable().optional(),
}
/** A triage of a case, with the classification it was made on. */
const triage = {
  caseId: id,
  /** The case's reports when it was triaged. */
  reportIds: ids,
  categoryId: id,
  customCategoryId: id.nullable(),
  signals: z.array(z.string()),
  injectionSuspected: z.boolean(),
  classifiedBy: z.enum(['llm', 'rules']),
  severity,
  /** Higher is more urgent. */
  priority: z.number(),
  slaDueAt: time,
  suggestedActionKeys: z.array(z.string()),
  /** The triage rules that applied, in triage's order. */
  applied: z.array(z.string()).optional(),
  flags: z.array(z.string()).optional(),
}
/** What a report says about the accounts; account times null when not given. */
const reportFacts = z.strictObject({ reporterExternalId: id, reporterAccountCreatedAt: time.nullable(), reportedAccountCreatedAt: time.nullable() })
const actionKey = policyActionKeySchema
const appCategory = policyCategorySchema
const llmSettings = policyLlmSettingsSchema

const SPECS = [
  spec({
    name: 'report.received',
    major: 1,
    version: '1.2.0',
    owner: 'flagging',
    meaning: 'A report was accepted, its evidence stored and the pre-rules run over it; it has no case yet.',
    schema: z.strictObject({
      reportId: id,
      subjectExternalId: id,
      /** The pre-rules found a P0 signal. */
      p0Signal: z.boolean(),
      /** Since 1.1.0: the P0 signals the pre-rules found, in P0_SIGNALS order. */
      p0Signals: z.array(z.enum(P0_SIGNALS)).optional(),
      /** Since 1.1.0: the pre-rules found text that tries to steer the classifier. */
      injectionSuspected: z.boolean().optional(),
      /** What the report says about the accounts; account times null when not given. */
      facts: reportFacts.optional(),
      /** Since 1.2.0: where the evidence snapshot is, opaque to readers, who read it as given with read-only access. */
      evidenceRef: z.string().min(1).optional(),
    }),
  }),
  spec({
    name: 'case.opened',
    major: 1,
    version: '1.1.0',
    owner: 'moderation',
    meaning: 'A report opened a new case, in the band of its P0 signal.',
    schema: z.strictObject({
      caseId: id,
      reportId: id,
      subjectExternalId: id,
      band: z.enum(['p0', 'standard']),
      /** Since 1.1.0: what the report said about the accounts, when it said it. */
      facts: reportFacts.optional(),
      occurredAt: time,
    }),
  }),
  spec({
    name: 'case.report_attached',
    major: 1,
    version: '1.1.0',
    owner: 'moderation',
    meaning: "A report joined the reported account's open case in its band.",
    schema: z.strictObject({
      caseId: id,
      reportId: id,
      /** Since 1.1.0: what the report said about the accounts, when it said it. */
      facts: reportFacts.optional(),
      occurredAt: time,
    }),
  }),
  spec({
    name: 'case.classified',
    major: 1,
    version: '1.0.0',
    owner: 'classify',
    meaning: 'A new case was classified, by the LLM or by rules (rulesReason says why).',
    schema: z.strictObject(classification),
  }),
  spec({
    name: 'case.reclassified',
    major: 1,
    version: '1.0.0',
    owner: 'classify',
    meaning: 'The LLM classified a case that rules had classified because the LLM failed.',
    schema: z.strictObject(classification),
  }),
  spec({
    name: 'case.triaged',
    major: 1,
    version: '1.1.0',
    owner: 'triage',
    meaning: 'A case got its severity, priority, SLA due time and suggested actions.',
    schema: z.strictObject({
      ...triage,
      /** Why triage ran: the first classification, the LLM's answer after it failed, or a moderator's correction. Missing on events from before it was carried. */
      cause: z.enum(['classification', 'llm_retry', 'correction']).optional(),
    }),
  }),
  spec({
    name: 'case.retriaged',
    major: 1,
    version: '1.0.0',
    owner: 'moderation',
    meaning: "Moderation took triage's new triage of a case after the LLM answered: no moderator had claimed the case yet.",
    schema: z.strictObject(triage),
  }),
  spec({
    name: 'case.untriaged',
    major: 1,
    version: '1.0.0',
    owner: 'triage',
    meaning: 'A case waits for a moderator to triage it: the LLM failed and the app does not fall back to rules.',
    schema: z.strictObject({ caseId: id, reason: z.enum(['provider_error']) }),
  }),
  spec({
    name: 'case.claimed',
    major: 1,
    version: '1.0.0',
    owner: 'moderation',
    meaning: 'A member claimed a case.',
    schema: z.strictObject({ caseId: id, memberId: id, occurredAt: time }),
  }),
  spec({
    name: 'case.released',
    major: 1,
    version: '1.0.0',
    owner: 'moderation',
    meaning: "A member's claim on a case ended: released, taken over (forced) or left idle.",
    schema: z.strictObject({ caseId: id, memberId: id, reason: z.enum(['released', 'forced', 'idle']), occurredAt: time }),
  }),
  spec({
    name: 'case.decided',
    major: 1,
    version: '1.0.0',
    owner: 'moderation',
    meaning: 'A case was decided, with the action keys the decision asks for.',
    schema: z.strictObject({
      caseId: id,
      subjectExternalId: id,
      decisionId: id,
      outcome: z.enum(['violation', 'no_violation']),
      categoryId: id,
      severity,
      actionKeys: z.array(z.string()),
      reportIds: ids,
      decidedBy: id,
      occurredAt: time,
    }),
  }),
  spec({
    name: 'case.corrected',
    major: 1,
    version: '1.0.0',
    owner: 'moderation',
    meaning: 'A moderator changed the category or severity of a case before deciding it; triage ran again.',
    schema: z.strictObject({
      caseId: id,
      /** severity null: the case was untriaged and the correction triaged it by hand. */
      before: z.strictObject({ categoryId: id, severity: severity.nullable() }),
      after: z.strictObject({ categoryId: id, severity, priority: z.number(), slaDueAt: time }),
      correctedBy: id,
      occurredAt: time,
    }),
  }),
  spec({
    name: 'case.corrected',
    major: 2,
    version: '2.0.0',
    owner: 'moderation',
    meaning: 'A moderator changed the category or severity of a case before deciding it, or triaged an untriaged case by hand; triage triages it again.',
    schema: z.strictObject({
      caseId: id,
      /** severity null: the case was untriaged and the moderator triages it by hand. */
      before: z.strictObject({ categoryId: id, severity: severity.nullable() }),
      /** The moderator's category, and severity; severity null to take the category's own. */
      after: z.strictObject({ categoryId: id, severity: severity.nullable() }),
      correctedBy: id,
      occurredAt: time,
    }),
  }),
  spec({
    name: 'case.actions_retried',
    major: 1,
    version: '1.1.0',
    owner: 'moderation',
    meaning: 'A moderator answered the failed actions of a decision: retry them, pick others, or none; delivery carries it out.',
    schema: z.strictObject({
      caseId: id,
      decisionId: id,
      subjectExternalId: id,
      categoryId: id,
      severity,
      actionKeys: z.array(z.string()),
      /**
       * Since 1.1.0: the failed requests the retry answers, the ones moderation knew of; delivery
       * replaces exactly these. Missing: every failed request not replaced yet.
       */
      replaces: ids.optional(),
      retriedBy: id,
      occurredAt: time,
    }),
  }),
  spec({
    name: 'action.requested',
    major: 1,
    version: '1.0.0',
    owner: 'delivery',
    meaning: "An action of a decision is to be carried out by the appRef's systems.",
    schema: z.strictObject({
      actionRequestId: id,
      caseId: id,
      actionKey: id,
      decisionId: id,
      subjectExternalId: id,
      categoryId: id,
      severity,
      reason: z.enum(['decision']),
      requestedBy,
      /** The failed requests this one answers, when a moderator retried failed actions. */
      replaces: ids.optional(),
    }),
  }),
  spec({
    name: 'action.confirmed',
    major: 1,
    version: '1.0.0',
    owner: 'delivery',
    meaning: "The appRef's systems carried out a requested action.",
    schema: z.strictObject({ actionRequestId: id, caseId: id }),
  }),
  spec({
    name: 'action.failed',
    major: 1,
    version: '1.0.0',
    owner: 'delivery',
    meaning: "The appRef's systems could not carry out a requested action.",
    schema: z.strictObject({ actionRequestId: id, caseId: id }),
  }),
  spec({
    name: 'decision.actions_confirmed',
    major: 1,
    version: '1.0.0',
    owner: 'delivery',
    meaning: 'Every action request of a decision is confirmed.',
    schema: z.strictObject({ caseId: id, decisionId: id }),
  }),
  spec({
    name: 'api_key.issued',
    major: 1,
    version: '1.0.0',
    owner: 'auth',
    meaning: 'An API key was issued with its scopes.',
    schema: z.strictObject({ keyId: id, scopes: z.array(z.enum(['ingest', 'actions', 'admin'])), occurredAt: time }),
  }),
  spec({
    name: 'api_key.issued',
    major: 2,
    version: '2.0.0',
    owner: 'auth',
    meaning: 'An API key was issued with its scopes; the scope for sending reports is named flagging, after its service (ingest in v1).',
    schema: z.strictObject({ keyId: id, scopes: z.array(z.enum(['flagging', 'actions', 'admin'])), occurredAt: time }),
  }),
  spec({
    name: 'api_key.rotated',
    major: 1,
    version: '1.0.0',
    owner: 'auth',
    meaning: 'An API key was replaced by a new one; the old one works until it expires.',
    schema: z.strictObject({ keyId: id, replacedBy: id, expiresAt: time, occurredAt: time }),
  }),
  spec({
    name: 'api_key.revoked',
    major: 1,
    version: '1.0.0',
    owner: 'auth',
    meaning: 'An API key stopped working.',
    schema: z.strictObject({ keyId: id, occurredAt: time }),
  }),
  spec({
    name: 'app.created',
    major: 1,
    version: '1.0.0',
    owner: 'apps',
    meaning: 'An app was created; its facts are written in live mode and hold for both modes.',
    schema: z.strictObject({ appId: id, name: z.string().min(1), occurredAt: time }),
  }),
  spec({
    name: 'app.deletion_requested',
    major: 1,
    version: '1.0.0',
    owner: 'apps',
    meaning: 'An app was deleted: its API keys stop working, and it can be restored until purgeAt.',
    schema: z.strictObject({ appId: id, purgeAt: time, occurredAt: time }),
  }),
  spec({
    name: 'app.restored',
    major: 1,
    version: '1.0.0',
    owner: 'apps',
    meaning: 'A deleted app was restored within its grace period.',
    schema: z.strictObject({ appId: id, occurredAt: time }),
  }),
  spec({
    name: 'config.action_keys_replaced',
    major: 1,
    version: '1.0.0',
    owner: 'policy',
    meaning: "An app's action keys were replaced; before and after are the whole lists.",
    schema: z.strictObject({ appId: id, before: z.array(actionKey), after: z.array(actionKey), occurredAt: time }),
  }),
  spec({
    name: 'config.categories_replaced',
    major: 1,
    version: '1.0.0',
    owner: 'policy',
    meaning: "An app's categories were replaced; before and after are the whole lists.",
    schema: z.strictObject({ appId: id, before: z.array(appCategory), after: z.array(appCategory), occurredAt: time }),
  }),
  spec({
    name: 'config.llm_settings_changed',
    major: 1,
    version: '1.0.0',
    owner: 'policy',
    meaning: "An app's LLM settings changed.",
    schema: z.strictObject({ appId: id, before: llmSettings, after: llmSettings, occurredAt: time }),
  }),
  spec({
    name: 'policy.updated',
    major: 1,
    version: '1.0.0',
    owner: 'policy',
    meaning: "An app's policy changed in a mode: the whole policy as of its new version, which counts up from 1 per app and mode.",
    schema: z.strictObject({ appId: id, version: z.int().min(1), policy: policySchema, occurredAt: time }),
  }),
  spec({
    name: 'subject.erasure_requested',
    major: 1,
    version: '1.0.0',
    owner: 'privacy',
    meaning: "A appRef asked to erase an account's personal data. Published tracked: every group it reaches answers with subject.erased.",
    schema: z.strictObject({ erasureId: id, subjectExternalId: id, occurredAt: time }),
  }),
  spec({
    name: 'subject.erased',
    major: 1,
    version: '1.0.0',
    owner: 'any',
    meaning: "One consumer group's answer to subject.erasure_requested: it erased the account's data, held none, or kept some under a legal hold.",
    schema: z.strictObject({
      erasureId: id,
      /** The consumer group that answers, as the bus named it in bus.event_fanned_out. */
      group: id,
      status: z.enum(['erased', 'nothing_held', 'retained']),
      /** How many items it kept under a legal hold (status retained). */
      heldItems: z.int().min(0),
      /** Why it kept them (status retained), else null. */
      reason: z.string().nullable(),
      occurredAt: time,
    }),
  }),
  spec({
    name: 'erasure.completed',
    major: 1,
    version: '1.0.0',
    owner: 'privacy',
    meaning: 'Every consumer group that got an erasure request answered it; held items are what legal holds kept.',
    schema: z.strictObject({ erasureId: id, subjectExternalId: id, heldItems: z.int().min(0), occurredAt: time }),
  }),
  spec({
    name: 'bus.event_fanned_out',
    major: 1,
    version: '1.0.0',
    owner: 'platform',
    meaning: 'The bus queued a tracked event for these consumer groups (none when no group takes its type).',
    schema: z.strictObject({ eventId: id, type: id, groups: ids }),
  }),
  spec({
    name: 'bus.delivery_dead_lettered',
    major: 1,
    version: '1.0.0',
    owner: 'platform',
    meaning: "A consumer group's delivery of a tracked event ran out of attempts and moved to the dead letters.",
    schema: z.strictObject({ eventId: id, type: id, group: id, attempts: z.int().min(1), error: z.string() }),
  }),
] as const

type Spec = (typeof SPECS)[number]

/** An event type on the bus: a fact and its major, `case.triaged.v1`. */
export type EventType = `${Spec['name']}.v${Spec['major']}`
/** A fact, without its major. */
export type FactName = Spec['name']
/** The data of an event type, as consumers receive it. */
export type EventData<T extends EventType> = z.output<Extract<Spec, { name: FactOf<T>; major: MajorOf<T> }>['schema']>
type FactOf<T extends string> = T extends `${infer N}.v${number}` ? N : never
type MajorOf<T extends string> = T extends `${string}.v${infer M extends number}` ? M : never

/** Every event type, by its name. */
export const EVENT_CATALOG: Readonly<Record<EventType, Spec>> = Object.fromEntries(SPECS.map((s) => [`${s.name}.v${s.major}`, s])) as Record<EventType, Spec>

/** The type a producer publishes a fact under: its newest major. */
export function currentType<N extends FactName>(name: N): `${N}.v${number}` & EventType {
  let newest: Spec | undefined
  for (const s of SPECS) if (s.name === name && (!newest || s.major > newest.major)) newest = s
  if (!newest) throw new EventContractError(`No event in the catalog is named ${name}`)
  return `${newest.name}.v${newest.major}` as `${N}.v${number}` & EventType
}

/** The fact and major of an event type, or null when it names no major. */
export function factOf(type: string): { readonly name: string; readonly major: number } | null {
  const m = /^(.+)\.v([1-9][0-9]*)$/.exec(type)
  return m ? { name: m[1]!, major: Number(m[2]) } : null
}

export class EventContractError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'EventContractError'
  }
}

/**
 * The catalog as the bus checks it: the schema version of a type, after its data (as JSON) passed
 * the type's schema. An EventContractError for a type not in the catalog or data that breaks it.
 */
export const eventContract = {
  versionOf(type: string, data: unknown): string {
    const s = (EVENT_CATALOG as Readonly<Record<string, Spec | undefined>>)[type]
    if (!s) throw new EventContractError(`Event type ${type} is not in the event catalog`)
    const result = s.schema.safeParse(data)
    if (!result.success) throw new EventContractError(`Event ${type} breaks its schema ${s.version}:\n${z.prettifyError(result.error)}`)
    return s.version
  },
}
