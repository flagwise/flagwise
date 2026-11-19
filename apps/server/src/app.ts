import { Hono } from 'hono'
import type { ModuleDefinition } from '@flagwise/kernel'
import type { FlagwisePlugin } from '@flagwise/plugin-api'
import { createApi, type ApiDeps } from './http/api.ts'
import { coreModules } from './modules.ts'

export interface CreateAppOptions {
  /** Cloud and Pro plugins, passed at build time. Self-host passes none. */
  readonly plugins?: readonly FlagwisePlugin[]
  /** Serves the public API at /v1 and /api/v1 (self-host) when given. */
  readonly api?: ApiDeps
  /** Checks what the server depends on; /readyz is 503 when it throws. Default: always ready. */
  readonly ready?: () => Promise<void>
}

export interface App {
  readonly http: Hono
  readonly modules: readonly ModuleDefinition[]
  readonly plugins: readonly FlagwisePlugin[]
}

export function createApp(opts: CreateAppOptions = {}): App {
  const plugins = opts.plugins ?? []
  for (const plugin of plugins) plugin.register({})

  const http = new Hono()
  http.get('/healthz', (c) => c.json({ status: 'ok' }))
  http.get('/readyz', async (c) => {
    try {
      await opts.ready?.()
      return c.json({ status: 'ok' })
    } catch {
      return c.json({ status: 'unavailable' }, 503)
    }
  })
  if (opts.api) {
    const api = createApi(opts.api)
    http.route('/v1', api)
    http.route('/api/v1', api)
  }

  return { http, modules: coreModules, plugins }
}
