// The auth service's composition root: it boots from the runtime alone.

import { defineService, withSystem, type RunningService } from '@flagwise/platform'
import { subscribeAuth } from './app/handlers.ts'
import { resolveApiKey, type KeyResolution } from './app/keys.ts'
import { authMigrations, pgAppCopies, pgKeyDirectory } from './infra/pg-auth-store.ts'

export interface RunningAuth extends RunningService {
  /** Checks a presented API key for the edge, through the key directory the system role reads. */
  readonly keys: { resolve(key: string, now: Date): Promise<KeyResolution> }
}

/** Its handlers: auth.apps (its copy of the apps) and its key check for the edge. */
export const auth = defineService<void, RunningAuth>({
  name: 'auth',
  migrations: authMigrations,
  boot({ db, bus, clock }) {
    subscribeAuth(bus, { apps: pgAppCopies(db), clock })
    return { keys: { resolve: (key, now) => withSystem(db, (tx) => resolveApiKey(pgKeyDirectory(tx), key, now)) } }
  },
})
