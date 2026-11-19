// The target checks of phase 1: what the code must look like once every service can boot on its
// own. They start red and turn green item by item; a check listed in ENFORCED fails the run when
// red, so it cannot regress. Most read the source tree; the event catalog check also reads what
// the scenarios saw on the bus (.wiring/events, written by each install on stop, cleared per run).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSeen } from './seen.ts'

export interface CheckResult {
  readonly id: string
  readonly title: string
  /** The phase 1 items that turn it green. */
  readonly items: string
  readonly green: boolean
  readonly detail: string
}

/**
 * Checks that fail `make wiring` when red: those of the items done, and of the item in progress,
 * so the run stays red until that item is complete.
 */
export const ENFORCED: readonly string[] = [
  'event-catalog', // item 1
  'no-service-imports', // item 3
  'policy-copies', // item 4
  'composition-only', // items 5+6
  'own-tables-only', // items 5+6
  'erasure-acks', // item 9
  'service-routes', // renames and routes
]

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MODULES_DIR = join(ROOT, 'packages/modules')
const SERVER_SRC = join(ROOT, 'apps/server/src')

const services = () => readdirSync(MODULES_DIR).filter((d) => statSync(join(MODULES_DIR, d)).isDirectory() && existsSync(join(MODULES_DIR, d, 'package.json'))).sort()

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name))
}

const read = (file: string) => readFileSync(file, 'utf8')
const rel = (file: string) => relative(ROOT, file)
const list = (items: readonly string[], max = 4) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`)

/** 1. A service imports only contracts, kernel and platform, never another service. */
function noServiceImports(): CheckResult {
  const names = services()
  const found: string[] = []
  for (const name of names) {
    for (const file of sourceFiles(join(MODULES_DIR, name, 'src'))) {
      for (const m of read(file).matchAll(/from '@flagwise\/([a-z-]+)'/g)) {
        if (m[1] !== name && names.includes(m[1]!)) found.push(`${rel(file)} -> ${m[1]}`)
      }
    }
  }
  return {
    id: 'no-service-imports',
    title: 'No service imports another (only contracts, kernel, platform)',
    items: '3, 11',
    green: found.length === 0,
    detail: found.length === 0 ? 'none' : `${found.length}: ${list(found)}`,
  }
}

/** 2. Every service has its own composition root (src/service.ts) and boots with only the bus and its storage. */
function bootsAlone(): CheckResult {
  const names = services()
  const missing = names.filter((n) => !existsSync(join(MODULES_DIR, n, 'src/service.ts')))
  return {
    id: 'boots-alone',
    title: 'Every service boots alone (own composition root, only the bus and its storage)',
    items: '11',
    green: missing.length === 0,
    detail: `${names.length - missing.length} of ${names.length} have src/service.ts`,
  }
}

/**
 * 3. No transaction or query touches another service's tables (static proxy until per-service
 * roles): no service's SQL names another service's schema, and every transaction apps/server opens
 * (withTenant, withSystem, pgUnitOfWork) uses the pg factories of one service only.
 */
function ownTablesOnly(): CheckResult {
  const names = services()
  const schemaOf = new Map<string, string>()
  for (const n of names) {
    const m = existsSync(join(MODULES_DIR, n, 'src/infra/schema.ts')) ? /pgSchema\('([a-z_]+)'\)/.exec(read(join(MODULES_DIR, n, 'src/infra/schema.ts'))) : null
    if (m) schemaOf.set(n, m[1]!)
  }
  const found: string[] = []
  for (const n of names) {
    const others = [...schemaOf].filter(([owner]) => owner !== n).map(([, s]) => s)
    if (others.length === 0) continue
    // SQL as the code writes it: an uppercase keyword, then the table (`policy.updated` in a comment is an event).
    const pattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+((?:${others.join('|')})\\.[a-z_]+)\\b`)
    for (const file of sourceFiles(join(MODULES_DIR, n, 'src'))) {
      for (const line of read(file).split('\n')) {
        const m = pattern.exec(line)
        if (m) found.push(`${rel(file)}: ${m[1]}`)
      }
    }
  }
  // apps/server composes: a transaction it opens uses the stores of one service only.
  for (const file of sourceFiles(SERVER_SRC)) {
    const text = read(file)
    const owner = new Map<string, string>()
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from '@flagwise\/([a-z-]+)'/g)) {
      if (!names.includes(m[2]!)) continue
      for (const n of m[1]!.split(',').map((x) => x.trim().replace(/^type\s+/, ''))) if (n) owner.set(n, m[2]!)
    }
    for (const span of callSpans(text, /\b(?:withTenant|withSystem|pgUnitOfWork)\(/g)) {
      const used = new Set([...span.matchAll(/\bpg[A-Z]\w*/g)].flatMap((m) => (owner.has(m[0]) ? [owner.get(m[0])!] : [])))
      if (used.size > 1) found.push(`${rel(file)}: one transaction across ${[...used].sort().join(', ')}`)
    }
  }
  return {
    id: 'own-tables-only',
    title: "No transaction or query touches another service's tables (static; DB roles per service with 11)",
    items: '4, 6',
    green: found.length === 0,
    detail: found.length === 0 ? 'none' : `${found.length}: ${list(found)}`,
  }
}

/** The text of each call matching `start` (which ends at its opening parenthesis), up to its closing one. */
function callSpans(text: string, start: RegExp): string[] {
  const spans: string[] = []
  for (const m of text.matchAll(start)) {
    let depth = 0
    for (let i = m.index! + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) {
        spans.push(text.slice(m.index!, i + 1))
        break
      }
    }
  }
  return spans
}

/** 4. apps/server only composes: no event handlers, no events of its own, no flow logic. */
function compositionOnly(): CheckResult {
  const found: string[] = []
  for (const file of sourceFiles(SERVER_SRC)) {
    const n = [...read(file).matchAll(/\.(?:subscribe|publish)\(/g)].length
    if (n > 0) found.push(`${rel(file)} (${n})`)
  }
  const flows = sourceFiles(join(SERVER_SRC, 'flows'))
  const green = found.length === 0 && flows.length === 0
  return {
    id: 'composition-only',
    title: 'apps/server only composes the services (no handlers, no events of its own, no flow logic)',
    items: '5',
    green,
    detail: green ? 'none' : `subscriptions or publishes in ${found.length} files: ${list(found)}; ${flows.length} files in apps/server/src/flows`,
  }
}

/**
 * 5. The event contracts: a catalog in @flagwise/contracts where every type names its major
 * (`case.triaged.v1`) and has a semver of that major and an owning service; every event the
 * scenarios published is a catalogued type stored with its catalogued schema version (so the bus
 * checked it); every consumer group subscribes to catalogued types only.
 */
async function eventCatalog(): Promise<CheckResult> {
  const title = 'Every event type is catalogued with its major, version and owner; events carry their schema version; consumers subscribe to majors'
  const result = (green: boolean, detail: string): CheckResult => ({ id: 'event-catalog', title, items: '1', green, detail })
  const contracts = (await import('@flagwise/contracts')) as Record<string, unknown>
  const catalog = contracts['EVENT_CATALOG'] as Readonly<Record<string, { name?: string; major?: number; version?: string; owner?: string; meaning?: string; schema?: unknown }>> | undefined
  const seen = readSeen()
  if (seen.installs === 0) return result(false, 'no events seen yet: run the scenarios first')
  const seenTypes = Object.keys(seen.events).sort()
  if (!catalog) return result(false, `no EVENT_CATALOG in @flagwise/contracts; ${seenTypes.length} event types seen`)

  // The bus's own facts are the platform's; an answer every service gives (subject.erased) is any's.
  const owners = [...services(), 'platform', 'any']
  const problems: string[] = []
  for (const [type, e] of Object.entries(catalog)) {
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(e.version ?? '')
    if (type !== `${e.name}.v${e.major}`) problems.push(`${type}: not named fact.vMAJOR`)
    else if (!semver || Number(semver[1]) !== e.major) problems.push(`${type}: version ${e.version ?? 'missing'} is no semver of major ${e.major}`)
    if (!e.owner || !owners.includes(e.owner)) problems.push(`${type}: owner ${e.owner ?? 'missing'} is no service`)
    if (!e.meaning || !e.schema) problems.push(`${type}: no meaning or schema`)
  }
  for (const type of seenTypes) {
    const e = catalog[type]
    if (!e) {
      problems.push(`${type}: published, not catalogued`)
      continue
    }
    const wrong = seen.events[type]!.filter((v) => v !== e.version)
    if (wrong.length > 0) problems.push(`${type}: stored with schema version ${wrong.map((v) => v ?? 'none').join(', ')}, catalogue says ${e.version}`)
  }
  for (const [group, types] of Object.entries(seen.groups)) {
    for (const t of types ?? []) if (!catalog[t]) problems.push(`group ${group} subscribes to ${t}, not catalogued`)
  }
  const groups = Object.keys(seen.groups).length
  return problems.length === 0
    ? result(true, `${Object.keys(catalog).length} types catalogued; ${seenTypes.length} published, all checked; ${groups} groups subscribe to majors`)
    : result(false, `${problems.length} problems: ${list(problems, 3)}`)
}

/** 6. Every service that stores data acks erasure. */
function erasureAcks(): CheckResult {
  const holders = services().filter((n) => existsSync(join(MODULES_DIR, n, 'src/infra/schema.ts')))
  // It subscribes to the request and answers: with subject.erased itself or contracts' erasureAnswer.
  const answers = (text: string) => text.includes("'subject.erasure_requested'") && (text.includes("'subject.erased'") || text.includes('erasureAnswer('))
  const missing = holders.filter((n) => !sourceFiles(join(MODULES_DIR, n, 'src')).some((f) => answers(read(f))))
  return {
    id: 'erasure-acks',
    title: 'Every service that stores data handles subject.erasure_requested and acks subject.erased',
    items: '9',
    green: missing.length === 0,
    detail: missing.length === 0 ? `${holders.length} services` : `${holders.length - missing.length} of ${holders.length}; missing: ${list(missing, 6)}`,
  }
}

/** 7. Every notification type that clears by fact names its clearing fact. */
async function notificationClears(): Promise<CheckResult> {
  const contracts = (await import('@flagwise/contracts')) as Record<string, unknown>
  const types = contracts['NOTIFICATION_TYPES'] as Readonly<Record<string, { clears: string; clearedBy?: readonly string[] }>> | undefined
  const title = 'Every by_fact notification type names a clearing fact from the same service'
  if (!types) return { id: 'notification-clears', title, items: '10', green: false, detail: 'no NOTIFICATION_TYPES in @flagwise/contracts yet' }
  const missing = Object.entries(types)
    .filter(([, t]) => t.clears === 'by_fact' && !(t.clearedBy && t.clearedBy.length > 0))
    .map(([k]) => k)
  return { id: 'notification-clears', title, items: '10', green: missing.length === 0, detail: missing.length === 0 ? `${Object.keys(types).length} types` : `no clearing fact: ${list(missing)}` }
}

/**
 * 8. The policy service owns the policy and publishes it whole; every service that reads it keeps
 * its own copy: no code outside the policy service uses a policy store, each reader has a
 * `policy_copies` table, and a consumer group of each reader subscribes to policy.updated.
 */
function policyCopies(): CheckResult {
  const result = (green: boolean, detail: string): CheckResult => ({
    id: 'policy-copies',
    title: 'Only the policy service reads its tables; classify, triage and moderation keep copies from policy.updated',
    items: '4',
    green,
    detail,
  })
  if (!services().includes('policy')) return result(false, 'no policy service yet')
  const problems: string[] = []
  const outside = [...sourceFiles(SERVER_SRC), ...services().filter((n) => n !== 'policy').flatMap((n) => sourceFiles(join(MODULES_DIR, n, 'src')))]
  for (const file of outside) {
    for (const m of read(file).matchAll(/import\s*\{([^}]*)\}\s*from '@flagwise\/policy'/g)) {
      const stores = m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter((n) => /^pg[A-Z]\w*Stores?$/.test(n))
      if (stores.length > 0) problems.push(`${rel(file)} uses ${stores.join(', ')}`)
    }
  }
  for (const reader of POLICY_READERS) {
    const schema = join(MODULES_DIR, reader, 'src/infra/schema.ts')
    if (!existsSync(schema) || !/copyTable\(schema, 'policy_copies'\)/.test(read(schema))) problems.push(`${reader} keeps no policy_copies`)
  }
  const seen = readSeen()
  if (seen.installs === 0) problems.push('no consumer groups seen yet: run the scenarios first')
  else {
    for (const reader of POLICY_READERS) {
      const subscribed = Object.entries(seen.groups).some(([g, types]) => g.startsWith(`${GROUP_PREFIX[reader] ?? reader}.`) && (types ?? []).includes('policy.updated.v1'))
      if (!subscribed) problems.push(`no ${reader} group subscribes to policy.updated.v1`)
    }
  }
  return problems.length === 0 ? result(true, `${POLICY_READERS.length} readers keep copies; no policy store outside the policy service`) : result(false, `${problems.length} problems: ${list(problems, 3)}`)
}

/**
 * 9. Every public route sits under its service's name, `/v1/{service}/{resource}[/{id}[/{action}]]`:
 * each service's routes are a Hono app with `basePath('/{service}')`, so a gateway routes by the
 * first segment, and a service booted alone serves the same paths.
 */
function serviceRoutes(): CheckResult {
  const problems: string[] = []
  let withRoutes = 0
  for (const name of services()) {
    const files = sourceFiles(join(MODULES_DIR, name, 'src/api'))
    if (files.length === 0) continue
    withRoutes++
    for (const file of files) {
      const text = read(file)
      for (const m of text.matchAll(/new Hono<[^>]*>\(\)(\.basePath\('([^']*)'\))?/g)) {
        if (m[2] !== `/${name}`) problems.push(`${rel(file)}: ${m[2] === undefined ? 'no basePath' : `basePath ${m[2]}`}, not /${name}`)
      }
    }
  }
  return {
    id: 'service-routes',
    title: "Every public route sits under its service's name (/v1/{service}/...)",
    items: 'renames',
    green: problems.length === 0,
    detail: problems.length === 0 ? `${withRoutes} services serve routes, each under its name` : `${problems.length}: ${list(problems)}`,
  }
}

/** The services that read the policy: classify (categories, LLM settings), triage (category rules, fallback to rules), moderation (action keys). */
const POLICY_READERS = ['classify', 'triage', 'moderation']

/** Consumer groups keep a service's first name, an internal id that does not change with it. */
const GROUP_PREFIX: Readonly<Record<string, string>> = { moderation: 'cases', flagging: 'intake' }

export async function runChecks(): Promise<readonly CheckResult[]> {
  return [noServiceImports(), bootsAlone(), ownTablesOnly(), compositionOnly(), await eventCatalog(), erasureAcks(), await notificationClears(), policyCopies(), serviceRoutes()]
}
