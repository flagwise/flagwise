// The architecture rules that only the code's text shows; dependency-cruiser checks the imports,
// apps/server's boot test the booted services, contracts' tests the catalog. Each rule finds the
// services itself (every package under packages/modules), so a new one is held to them from its
// first commit. Exits 1 when one is broken.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MODULES_DIR = join(ROOT, 'packages/modules')
const SERVER_SRC = join(ROOT, 'apps/server/src')

const services = readdirSync(MODULES_DIR).filter((d) => statSync(join(MODULES_DIR, d)).isDirectory() && existsSync(join(MODULES_DIR, d, 'package.json'))).sort()
const read = (file: string) => readFileSync(file, 'utf8')
const rel = (file: string) => relative(ROOT, file)

function sourceFiles(dir: string, ext = '.ts'): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext) && !join(e.parentPath, e.name).includes('node_modules'))
    .map((e) => join(e.parentPath, e.name))
}

/** The text of each call matching `start` (which ends at its opening parenthesis), up to its closing one. */
function callSpans(text: string, start: RegExp): string[] {
  const spans: string[] = []
  for (const m of text.matchAll(start)) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')' && --depth === 0) {
        spans.push(text.slice(m.index, i + 1))
        break
      }
    }
  }
  return spans
}

/** The names apps/server imports from a service package, as values (types are free). */
function serviceImports(text: string): { pkg: string; names: string[] }[] {
  return [...text.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from '@flagwise\/([a-z-]+)'/g)]
    .filter((m) => !m[1] && services.includes(m[3]!))
    .map((m) => ({ pkg: m[3]!, names: m[2]!.split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('type ')) }))
}

interface Rule {
  readonly id: string
  readonly title: string
  check(): string[]
}

const RULES: readonly Rule[] = [
  {
    id: 'own-tables-only',
    title: "No service's SQL names another service's schema, and no transaction apps/server opens uses two services' stores",
    check() {
      const schemaOf = new Map<string, string>()
      for (const n of services) {
        const file = join(MODULES_DIR, n, 'src/infra/schema.ts')
        const m = existsSync(file) ? /pgSchema\('([a-z_]+)'\)/.exec(read(file)) : null
        if (m) schemaOf.set(n, m[1]!)
      }
      const found: string[] = []
      for (const n of services) {
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
      for (const file of sourceFiles(SERVER_SRC)) {
        const text = read(file)
        const owner = new Map(serviceImports(text).flatMap(({ pkg, names }) => names.map((n) => [n, pkg] as const)))
        for (const span of callSpans(text, /\b(?:withApps|withSystem|pgUnitOfWork)\(/g)) {
          const used = new Set([...span.matchAll(/\bpg[A-Z]\w*/g)].flatMap((m) => (owner.has(m[0]) ? [owner.get(m[0])!] : [])))
          if (used.size > 1) found.push(`${rel(file)}: one transaction across ${[...used].sort().join(', ')}`)
        }
      }
      return found
    },
  },
  {
    id: 'server-only-boots',
    title: 'apps/server boots every service with {name}.boot(...), imports nothing else of a service but types (its setup commands aside), and has no handlers or events of its own',
    check() {
      const found: string[] = []
      const server = read(join(SERVER_SRC, 'server.ts'))
      for (const n of services) if (!server.includes(`${n}.boot(`)) found.push(`apps/server/src/server.ts does not boot ${n}`)
      for (const file of [join(SERVER_SRC, 'server.ts'), ...sourceFiles(join(SERVER_SRC, 'http'))]) {
        for (const { pkg, names } of serviceImports(read(file))) for (const v of names) if (v !== pkg) found.push(`${rel(file)}: ${v} from ${pkg}`)
      }
      for (const file of sourceFiles(SERVER_SRC)) {
        const n = [...read(file).matchAll(/\.(?:subscribe|publish)\(/g)].length
        if (n > 0) found.push(`${rel(file)}: ${n} subscriptions or publishes`)
      }
      return found
    },
  },
  {
    id: 'no-org',
    title: 'The core has no org: apps are its top level (no org in code, columns or tables)',
    check() {
      const pattern = /\b(?:orgId|org_id|orgRole|OrgRole|createOrg|orgsTable)\b|\bOrg[A-Z]\w*|\btenancy\.orgs\b/
      const found: string[] = []
      for (const root of [join(ROOT, 'packages'), join(ROOT, 'apps')]) {
        for (const file of [...sourceFiles(root), ...sourceFiles(root, '.sql')]) {
          const hit = read(file).split('\n').findIndex((line) => pattern.test(line))
          if (hit >= 0) found.push(`${rel(file)}:${hit + 1}`)
        }
      }
      return found
    },
  },
]

let broken = 0
for (const rule of RULES) {
  const found = rule.check()
  if (found.length === 0) continue
  broken++
  console.error(`${rule.id}: ${rule.title}\n${found.map((f) => `  ${f}`).join('\n')}`)
}
if (broken > 0) process.exit(1)
console.log(`✔ ${RULES.length} architecture rules hold (${services.length} services)`)
