// What an install saw on the bus, recorded on stop for the scoreboard: each event type with the
// schema versions it was stored under, and each consumer group with the types it subscribes to.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SEEN_DIR = fileURLToPath(new URL('../.wiring/events/', import.meta.url))

export interface Seen {
  /** Event type -> the schema versions its events carried; null for an event stored without one. */
  readonly events: Readonly<Record<string, readonly (string | null)[]>>
  /** Consumer group -> its types; null for every type. */
  readonly groups: Readonly<Record<string, readonly string[] | null>>
}

export function recordSeen(name: string, seen: Seen): void {
  mkdirSync(SEEN_DIR, { recursive: true })
  writeFileSync(join(SEEN_DIR, `${name}.json`), JSON.stringify(seen, null, 2))
}

/** Everything every install of the last run saw, merged. */
export function readSeen(): Seen & { readonly installs: number } {
  const events: Record<string, (string | null)[]> = {}
  const groups: Record<string, readonly string[] | null> = {}
  const files = existsSync(SEEN_DIR) ? readdirSync(SEEN_DIR).filter((f) => f.endsWith('.json')) : []
  for (const f of files) {
    const s = JSON.parse(readFileSync(join(SEEN_DIR, f), 'utf8')) as Partial<Seen>
    if (!s.events || !s.groups) continue
    for (const [type, versions] of Object.entries(s.events)) events[type] = [...new Set([...(events[type] ?? []), ...versions])]
    Object.assign(groups, s.groups)
  }
  return { events, groups, installs: files.length }
}
