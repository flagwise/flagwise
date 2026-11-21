// The test suites, run from the root (scripts/test.ts starts a throwaway Postgres for the ones that
// need it, unless TEST_DATABASE_URL is set):
// - unit: each package's tests of its own code alone (`test/*.test.ts` beside the code); needs nothing.
// - database: each package's code on a real Postgres: its SQL, RLS, roles, the bus (`test/*.pg.test.ts`).
// - integration: the whole server, every service wired, through its API, webhooks and setup (`tests/integration`).

import { defineConfig } from 'vitest/config'

const PACKAGE_TESTS = '{apps,packages}/**/test/**'
const EXCLUDE = ['**/node_modules/**']

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'unit', include: [`${PACKAGE_TESTS}/*.test.ts`], exclude: [...EXCLUDE, '**/*.pg.test.ts'] } },
      { test: { name: 'database', include: [`${PACKAGE_TESTS}/*.pg.test.ts`], exclude: EXCLUDE } },
      { test: { name: 'integration', include: ['tests/integration/scenarios/**/*.test.ts'], exclude: EXCLUDE } },
    ],
  },
})
