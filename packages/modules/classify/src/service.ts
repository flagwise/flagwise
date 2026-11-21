// The classify service's composition root: it boots from the runtime, the evidence storage it
// reads and the install's LLM.

import { defineService, type ObjectStorage } from '@flagwise/platform'
import { classifyRoutes } from './api/routes.ts'
import { classifyDepsWithPolicy, subscribeClassify } from './app/handlers.ts'
import type { ClassifyDeps } from './app/ports.ts'
import { classifyMigrations, pgClassifyRunner } from './infra/pg-classification-store.ts'
import { pgClassifyPolicyCopy } from './infra/pg-policy-copy.ts'

export interface ClassifyOptions extends Pick<ClassifyDeps, 'llm' | 'redact'> {
  /** Where flagging wrote the evidence snapshots; classify only reads them. */
  readonly storage: Pick<ObjectStorage, 'get'>
  /** Waits before each LLM retry; default LLM_RETRY_DELAYS_MS. */
  readonly llmRetryDelaysMs?: readonly number[]
}

/** Its handlers (classify.policy, classify, classify.erasure) and the /classify routes. */
export const classify = defineService<ClassifyOptions>({
  name: 'classify',
  migrations: classifyMigrations,
  boot({ db, bus, clock }, options) {
    const policy = pgClassifyPolicyCopy(db)
    const deps = classifyDepsWithPolicy({ run: pgClassifyRunner(db), snapshots: options.storage, clock, llm: options.llm, redact: options.redact }, policy)
    subscribeClassify(bus, { classify: deps, policy, ...(options.llmRetryDelaysMs && { llmRetryDelaysMs: options.llmRetryDelaysMs }) })
    return { routes: classifyRoutes(deps) }
  },
})
