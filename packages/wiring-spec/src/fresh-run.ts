// Vitest global setup: forgets what the last run saw, so the scoreboard reads only this run.

import { rmSync } from 'node:fs'
import { SEEN_DIR } from './seen.ts'

export default function freshRun(): void {
  rmSync(SEEN_DIR, { recursive: true, force: true })
}
