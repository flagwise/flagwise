// The flagwise CLI: setting up the database and the first app. Reads the same environment as the
// server (.env through the package script).

import { parseArgs } from 'node:util'
import { newKeyringEntry } from '@flagwise/platform'
import { PRESET_NAMES, type PresetName } from '@flagwise/policy'
import { serverConfigFromEnv } from './config/server.ts'
import {
  addWebhookEndpoint,
  bootstrap,
  createKey,
  initDatabaseFromEnv,
  listWebhookEndpoints,
  migrateFromEnv,
  removeWebhookEndpoint,
  rewrapSecrets,
  rollWebhookSecret,
} from './setup.ts'

const USAGE = `Usage: flagwise <command>

  db:init                          Create the database roles. With DATABASE_URL alone the server does
                                   this itself; with role URLs it needs DATABASE_ADMIN_URL.
  db:migrate                       Run pending migrations as DATABASE_OWNER_URL, else DATABASE_URL.
                                   With DATABASE_URL alone the server does this itself.
  bootstrap --app <name> [--preset dating|marketplace|community]
                                   Create an app and its live and test API keys
                                   (flagging and actions scopes); with --preset, the app starts with
                                   that preset's categories in both modes.
  keys:create --app <app_id> --scope <scopes> [--test]
                                   Issue an API key for the app; scopes are comma-separated
                                   (flagging, actions, admin). Live mode unless --test.

  Webhooks (each for one app and mode: --app <app_id>, live unless --test):
  webhooks:add --url <https url> [--events <types>]
                                   Add an endpoint (at most 3); --events is comma-separated, default
                                   every type. The app's first endpoint also makes its signing secret.
  webhooks:list                    List the endpoints.
  webhooks:remove --id <whe_id>    Remove an endpoint; its pending deliveries fail.
  webhooks:roll-secret [--overlap <duration>]
                                   Make a new signing secret; the old one keeps signing for the
                                   overlap (default 24h, at most 7d; such as 0, 30m, 24h, 7d).

  Secrets at rest (SECRETS_ENCRYPTION_KEY holds id:base64key entries, current first, or a file holding them):
  secrets:new-key [--id <id>]      Print a new key entry (default id: k + today's date).
  secrets:rewrap                   Reseal every stored secret with the current key, after putting a
                                   new key first and keeping the old one after it.`

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
      app: { type: 'string' },
      scope: { type: 'string' },
      test: { type: 'boolean' },
      url: { type: 'string' },
      events: { type: 'string' },
      id: { type: 'string' },
      overlap: { type: 'string' },
      preset: { type: 'string' },
    }, })
  switch (positionals[0]) {
    case 'db:init':
      await initDatabaseFromEnv(process.env)
      console.log('The database roles are ready.')
      return 0
    case 'db:migrate': {
      const applied = await migrateFromEnv(process.env)
      console.log(applied.length ? `Applied ${applied.length} migrations:\n${applied.map((m) => `  ${m}`).join('\n')}` : 'No pending migrations.')
      return 0
    }
    case 'bootstrap': {
      if (!values.app) {
        console.error('bootstrap needs --app <name>')
        return 2
      }
      if (values.preset !== undefined && !PRESET_NAMES.includes(values.preset as PresetName)) {
        console.error(`--preset is one of ${PRESET_NAMES.join(', ')}`)
        return 2
      }
      const { app, liveKey, testKey } = await bootstrap(await serverConfigFromEnv(process.env), {
        appName: values.app,
        ...(values.preset !== undefined && { preset: values.preset as PresetName }),
      })
      console.log(`Created app ${app.id} (${app.name}).

Live API key: ${liveKey}
Test API key: ${testKey}

These keys are shown only once. Store them now.`)
      return 0
    }
    case 'keys:create': {
      if (!values.app || !values.scope) {
        console.error('keys:create needs --app <app_id> and --scope <scopes>')
        return 2
      }
      const scopes = values.scope.split(',').map((s) => s.trim()).filter(Boolean)
      const created = await createKey(await serverConfigFromEnv(process.env), { appId: values.app, scopes, livemode: !values.test })
      console.log(`Created ${created.livemode ? 'live' : 'test'} API key ${created.id} with scopes ${created.scopes.join(', ')}:

${created.key}

This key is shown only once. Store it now.`)
      return 0
    }
    case 'webhooks:add':
    case 'webhooks:list':
    case 'webhooks:remove':
    case 'webhooks:roll-secret': {
      if (!values.app) {
        console.error(`${positionals[0]} needs --app <app_id>`)
        return 2
      }
      const appRef = { appId: values.app, livemode: !values.test }
      const mode = appRef.livemode ? 'live' : 'test'
      const config = await serverConfigFromEnv(process.env)
      if (positionals[0] === 'webhooks:add') {
        if (!values.url) {
          console.error('webhooks:add needs --url <url>')
          return 2
        }
        const events = values.events?.split(',').map((e) => e.trim()).filter(Boolean)
        const { endpoint, secret } = await addWebhookEndpoint(config, appRef, { url: values.url, ...(events && { eventTypes: events }) })
        console.log(`Added ${mode} endpoint ${endpoint.id}: ${endpoint.url} (${endpoint.eventTypes?.join(', ') ?? 'every event type'})`)
        if (secret) console.log(`\nSigning secret: ${secret}\n\nThis secret is shown only once. Store it now; webhooks:roll-secret makes a new one.`)
        return 0
      }
      if (positionals[0] === 'webhooks:list') {
        const endpoints = await listWebhookEndpoints(config, appRef)
        if (endpoints.length === 0) console.log(`No ${mode} webhook endpoints.`)
        for (const e of endpoints) console.log(`${e.id}  ${e.url}  ${e.eventTypes?.join(',') ?? 'all'}  added ${e.createdAt.toISOString()}`)
        return 0
      }
      if (positionals[0] === 'webhooks:remove') {
        if (!values.id) {
          console.error('webhooks:remove needs --id <whe_id>')
          return 2
        }
        await removeWebhookEndpoint(config, appRef, values.id)
        console.log(`Removed endpoint ${values.id}.`)
        return 0
      }
      const overlapMs = parseDuration(values.overlap ?? '24h')
      if (overlapMs === null) {
        console.error('--overlap takes a duration such as 0, 30m, 24h or 7d')
        return 2
      }
      const rolled = await rollWebhookSecret(config, appRef, overlapMs)
      console.log(`New ${mode} signing secret (version ${rolled.version}): ${rolled.secret}

${rolled.previousExpireAt ? `The previous secret keeps signing until ${rolled.previousExpireAt.toISOString()}.` : 'There was no previous secret.'}
This secret is shown only once. Store it now.`)
      return 0
    }
    case 'secrets:new-key': {
      const id = values.id ?? `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
      console.log(`${newKeyringEntry(id)}

Put it first in SECRETS_ENCRYPTION_KEY (keep the old entry after it), restart, run secrets:rewrap, then drop the old entry.`)
      return 0
    }
    case 'secrets:rewrap': {
      const n = await rewrapSecrets(await serverConfigFromEnv(process.env))
      console.log(`Resealed ${n} secrets with the current key.`)
      return 0
    }
    default:
      console.error(USAGE)
      return 2
  }
}

/** `0`, or a whole number with s, m, h or d; null otherwise. */
function parseDuration(text: string): number | null {
  if (text === '0') return 0
  const match = /^(\d+)(s|m|h|d)$/.exec(text)
  if (!match) return null
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd']
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
