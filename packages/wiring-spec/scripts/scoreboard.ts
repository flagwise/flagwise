// Prints the target checks of phase 1 after the scenarios ran. Exits 1 when an enforced check is
// red, or any check with STRICT=1.

import { ENFORCED, runChecks } from '../src/targets.ts'

const strict = process.env['STRICT'] === '1'
const results = await runChecks()

const rows = results.map((r) => [r.green ? 'green' : 'red', ENFORCED.includes(r.id) ? 'yes' : 'no', r.items, r.id, r.detail])
const head = ['state', 'enforced', 'items', 'check', 'detail']
const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)))
const line = (cells: readonly string[]) => cells.map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  ')

console.log('\nPhase 1 target checks\n')
console.log(line(head))
console.log(line(widths.map((w) => '-'.repeat(w))))
for (const row of rows) console.log(line(row))
console.log('')
for (const r of results) console.log(`${r.id}: ${r.title}`)

const green = results.filter((r) => r.green).length
const failing = results.filter((r) => !r.green && (strict || ENFORCED.includes(r.id)))
console.log(`\n${green} of ${results.length} green${strict ? ' (STRICT: every check counts)' : `; ${ENFORCED.length} enforced`}`)
if (failing.length > 0) {
  console.log(`Failing: ${failing.map((r) => r.id).join(', ')}`)
  process.exit(1)
}
