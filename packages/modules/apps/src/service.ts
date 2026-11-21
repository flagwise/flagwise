// The apps service's composition root: it boots from the runtime alone.

import { defineService } from '@flagwise/platform'
import { subscribeApps } from './app/handlers.ts'
import { appsMigrations } from './infra/pg-app-store.ts'

/** Its handlers: apps.erasure. Apps are created, deleted and restored from the CLI. */
export const apps = defineService({
  name: 'apps',
  migrations: appsMigrations,
  boot({ bus, clock }) {
    subscribeApps(bus, { clock })
    return {}
  },
})
