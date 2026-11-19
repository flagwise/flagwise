// The server process. Reads its settings from the environment (.env through the package scripts),
// serves the API in MODE api or all and handles events in MODE worker or all.

import { serve } from '@hono/node-server'
import { serverConfigFromEnv } from './config/server.ts'
import { createServer } from './server.ts'

const log = (level: 'info' | 'error', msg: string, fields: Record<string, unknown> = {}) =>
  (level === 'error' ? console.error : console.log)(JSON.stringify({ level, msg, ...fields }))

let config
try {
  config = await serverConfigFromEnv(process.env)
} catch (err) {
  log('error', 'invalid configuration', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}

const server = createServer(config)
const http =
  config.mode === 'worker'
    ? undefined
    : serve({ fetch: server.app.http.fetch, port: config.port }, (info) => log('info', 'listening', { port: info.port, mode: config.mode }))
log('info', 'started', { mode: config.mode, database: config.database.setup, llm: config.llm.llm ? config.llm.llm.model : 'rules only', storage: config.storage.driver })
// Serving starts first (/readyz is 503 meanwhile), so the order of deploying and migrating does not matter.
server.start().then(
  () => log('info', 'ready', {}),
  (err: unknown) => {
    if (stopping) return
    log('error', 'database setup failed', { err: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  },
)

let stopping = false
const shutdown = async (signal: string) => {
  if (stopping) return
  stopping = true
  log('info', 'stopping', { signal })
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  await server.stop()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
