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
  'no-org', // no org in the core
  'auth-apps-split', // tenancy split into auth and apps
  'notification-clears', // item 10
  'boots-alone', // item 11
]

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MODULES_DIR = join(ROOT, 'packages/modules')
const SERVER_SRC = join(ROOT, 'apps/server/src')

const services = () => readdirSync(MODULES_DIR).filter((d) => statSync(join(MODULES_DIR, d)).isDirectory() && existsSync(join(MODULES_DIR, d, 'package.json'))).sort()

function sourceFiles(dir: string, ext = '.ts'): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
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

/**
 * 2. Every service boots alone: its src/service.ts defines it (`export const {name} =
 * defineService({ name: '{name}', ... })`, booting from the runtime and options of its own) and
 * its index exports it; apps/server boots each one with `{name}.boot(`, and its server and edge
 * import nothing else of a service but types. The CLI's setup commands (setup.ts) are not booting.
 */
function bootsAlone(): CheckResult {
  const names = services()
  const found: string[] = []
  for (const n of names) {
    const file = join(MODULES_DIR, n, 'src/service.ts')
    if (!existsSync(file)) {
      found.push(`${n}: no src/service.ts`)
      continue
    }
    if (!new RegExp(`export const ${n} = defineService(<[^>]*>)?\\(\\{\\s*name: '${n}'`).test(read(file))) found.push(`${n}: src/service.ts does not define ${n}`)
    if (!new RegExp(`export \\{ ${n} \\} from './service.ts'`).test(read(join(MODULES_DIR, n, 'src/index.ts')))) found.push(`${n}: index.ts does not export ${n}`)
  }
  const server = read(join(SERVER_SRC, 'server.ts'))
  for (const n of names) if (!server.includes(`${n}.boot(`)) found.push(`apps/server/src/server.ts: does not boot ${n}`)
  for (const file of [join(SERVER_SRC, 'server.ts'), ...sourceFiles(join(SERVER_SRC, 'http'))]) {
    for (const m of read(file).matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from '@flagwise\/([a-z-]+)'/g)) {
      const pkg = m[3]!
      if (m[1] || !names.includes(pkg)) continue
      const values = m[2]!.split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('type '))
      for (const v of values) if (v !== pkg) found.push(`${rel(file)}: ${v} from ${pkg}`)
    }
  }
  return {
    id: 'boots-alone',
    title: 'Every service boots alone (own composition root, only the bus and its storage)',
    items: '11',
    green: found.length === 0,
    detail: found.length === 0 ? `${names.length} of ${names.length} boot from src/service.ts` : `${found.length}: ${list(found)}`,
  }
}

/**
 * 3. No transaction or query touches another service's tables (static; apps/server's boots-alone
 * test boots each service on its own tables only, and DB roles per service come with detaching in
 * phase 2): no service's SQL names another service's schema, and every transaction apps/server
 * opens (withApps, withSystem, pgUnitOfWork) uses the pg factories of one service only.
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
    for (const span of callSpans(text, /\b(?:withApps|withSystem|pgUnitOfWork)\(/g)) {
      const used = new Set([...span.matchAll(/\bpg[A-Z]\w*/g)].flatMap((m) => (owner.has(m[0]) ? [owner.get(m[0])!] : [])))
      if (used.size > 1) found.push(`${rel(file)}: one transaction across ${[...used].sort().join(', ')}`)
    }
  }
  return {
    id: 'own-tables-only',
    title: "No transaction or query touches another service's tables (static; each boots on its own tables in apps/server's test)",
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

/**
 * 7. Every notification type that clears by fact names its clearing facts, each a catalogued fact
 * of the service that raises it: only the owner of a notification clears it.
 */
async function notificationClears(): Promise<CheckResult> {
  const contracts = (await import('@flagwise/contracts')) as Record<string, unknown>
  const types = contracts['NOTIFICATION_TYPES'] as Readonly<Record<string, { owner: string; clears: string; clearedBy?: readonly string[] }>> | undefined
  const catalog = contracts['EVENT_CATALOG'] as Readonly<Record<string, { name: string; owner: string }>> | undefined
  const title = 'Every by_fact notification type names a clearing fact from the same service'
  if (!types) return { id: 'notification-clears', title, items: '10', green: false, detail: 'no NOTIFICATION_TYPES in @flagwise/contracts yet' }
  const ownerOf = new Map(Object.values(catalog ?? {}).map((e) => [e.name, e.owner]))
  const problems: string[] = []
  for (const [type, t] of Object.entries(types)) {
    if (!services().includes(t.owner)) problems.push(`${type}: owner ${t.owner} is no service`)
    if (t.clears !== 'by_fact') continue
    if (!t.clearedBy || t.clearedBy.length === 0) problems.push(`${type}: no clearing fact`)
    for (const fact of t.clearedBy ?? []) {
      const owner = ownerOf.get(fact)
      if (owner === undefined) problems.push(`${type}: ${fact} is not catalogued`)
      else if (owner !== t.owner) problems.push(`${type}: ${fact} is ${owner}'s, not ${t.owner}'s`)
    }
  }
  return { id: 'notification-clears', title, items: '10', green: problems.length === 0, detail: problems.length === 0 ? `${Object.keys(types).length} types` : list(problems, 3) }
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

/**
 * 10. The core has no org: apps are its top level. No code names an org (orgId, org_id, OrgRole and
 * the like) and no migration makes an org column or table; an install that groups apps into orgs
 * (cloud) does so in its own services, through the core's seams.
 */
function noOrg(): CheckResult {
  const roots = [join(ROOT, 'packages'), join(ROOT, 'apps')]
  const pattern = /\b(?:orgId|org_id|orgRole|OrgRole|createOrg|orgsTable)\b|\bOrg[A-Z]\w*|\btenancy\.orgs\b/
  const found: string[] = []
  for (const root of roots) {
    for (const file of [...sourceFiles(root), ...sourceFiles(root, '.sql')]) {
      if (file.includes('node_modules') || file.includes('/wiring-spec/src/targets.ts')) continue
      const hit = read(file).split('\n').findIndex((line) => pattern.test(line))
      if (hit >= 0) found.push(`${rel(file)}:${hit + 1}`)
    }
  }
  return {
    id: 'no-org',
    title: 'The core has no org: apps are its top level (no org in code, columns or tables)',
    items: 'no-org',
    green: found.length === 0,
    detail: found.length === 0 ? 'none' : `${found.length} files: ${list(found)}`,
  }
}

/**
 * 11. Tenancy is split: auth (API keys, members, the Caller) and apps (the registry and its
 * lifecycle). Apps publishes facts and never knows auth; auth keeps its own copy of the apps from
 * app.created, app.deletion_requested and app.restored, in one consumer group so they stay in order.
 */
function authAppsSplit(): CheckResult {
  const names = services()
  const problems: string[] = []
  if (names.includes('tenancy')) problems.push('a tenancy service still exists')
  for (const n of ['auth', 'apps']) if (!names.includes(n)) problems.push(`no ${n} service`)
  for (const file of sourceFiles(join(MODULES_DIR, 'apps', 'src'))) {
    if (/@flagwise\/auth|\bauth\.[a-z_]+|api_?key/i.test(read(file))) problems.push(`${rel(file)} knows auth`)
  }
  const seen = readSeen()
  if (seen.installs === 0) problems.push('no consumer groups seen yet: run the scenarios first')
  else {
    const facts = ['app.created.v1', 'app.deletion_requested.v1', 'app.restored.v1']
    const copies = Object.entries(seen.groups).some(([g, types]) => g.startsWith('auth.') && facts.every((f) => (types ?? []).includes(f)))
    if (!copies) problems.push(`no auth group subscribes to ${facts.join(', ')}`)
  }
  return {
    id: 'auth-apps-split',
    title: 'Tenancy is split into auth and apps; apps never knows auth, auth copies the apps from their facts',
    items: 'split',
    green: problems.length === 0,
    detail: problems.length === 0 ? 'auth keeps its copy of the apps from app facts' : `${problems.length} problems: ${list(problems, 3)}`,
  }
}

/** The services that read the policy: classify (categories, LLM settings), triage (category rules, fallback to rules), moderation (action keys). */
const POLICY_READERS = ['classify', 'triage', 'moderation']

/** Consumer groups keep a service's first name, an internal id that does not change with it. */
const GROUP_PREFIX: Readonly<Record<string, string>> = { moderation: 'cases', flagging: 'intake' }

export async function runChecks(): Promise<readonly CheckResult[]> {
  return [noServiceImports(), bootsAlone(), ownTablesOnly(), compositionOnly(), await eventCatalog(), erasureAcks(), await notificationClears(), policyCopies(), serviceRoutes(), noOrg(), authAppsSplit()]
}
