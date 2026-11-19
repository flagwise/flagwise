import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each run starts without the facts of the last one, so the scoreboard sees only this run's.
    globalSetup: ['./src/fresh-run.ts'],
  },
})
