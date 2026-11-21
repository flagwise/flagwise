// Webhooks to the tenant: signed so the tenant's backend can check them (by the Standard Webhooks
// spec, checked here the way a tenant does), and the operator's endpoint commands: list, roll the
// signing secret, rewrap under a new master key, remove. Skipped without TEST_DATABASE_URL.
import { testDatabaseUrl } from '@flagwise/platform/testing'
import { addWebhookEndpoint, listWebhookEndpoints, removeWebhookEndpoint, rewrapSecrets, rollWebhookSecret, serverConfigFromEnv } from '@flagwise/server'
import { newKeyringEntry } from '@flagwise/platform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstall, type Install } from '../src/install.ts'
import { WEBHOOKS } from '../src/paths.ts'
import { signedWith } from '../src/signature.ts'
import { fileReport, webhooksOf } from '../src/steps.ts'

describe.skipIf(!testDatabaseUrl)('webhooks to the tenant', () => {
  let i: Install
  const triagedFor = async (reportId: string) => (await webhooksOf(i, WEBHOOKS.reportTriaged, (w) => w.data.report_ids?.includes(reportId)))[0]!

  beforeAll(async () => {
    i = await startInstall()
    i.net.llm = () => 'down'
  })
  afterAll(async () => {
    await i?.stop()
  })

  it('posts a signed report.triaged for a report, from the running worker', async () => {
    const reportId = await fileReport(i, { reported: 'u_john_doe', category: 'asking_for_money' })
    const hook = await triagedFor(reportId)
    expect(signedWith(i.webhookSecret, hook)).toBe(true)
    expect(signedWith(`whsec_${Buffer.alloc(32, 9).toString('base64')}`, hook)).toBe(false)
    expect(hook.headers['content-type']).toBe('application/json')
    const body = JSON.parse(hook.body)
    expect(body).toMatchObject({ type: 'report.triaged', app_id: i.appRef.appId, livemode: true, data: { category_id: 'other', classified_by: 'rules' } })
    expect(body.id).toMatch(/^evt_/)
    expect(hook.headers['webhook-id']).toBe(body.id)
  })

  it('signs with the new secret once the operator rolls it, and keeps endpoints through a new master key', async () => {
    const [endpoint] = await listWebhookEndpoints(i.config, i.appRef)
    expect(endpoint).toMatchObject({ url: 'https://hooks.integration.test/flagwise' })

    const rolled = await rollWebhookSecret(i.config, i.appRef, 0)
    expect(rolled.version).toBe(2)
    const hook = await triagedFor(await fileReport(i, { reported: 'u_jack_doe', category: 'asking_for_money' }))
    expect(signedWith(rolled.secret, hook)).toBe(true)

    // A new master key in front of the old one: every stored secret is sealed again, once.
    const rotated = await serverConfigFromEnv({ ...i.env, SECRETS_ENCRYPTION_KEY: `${newKeyringEntry('k2', () => new Uint8Array(32).fill(2))},${i.env['SECRETS_ENCRYPTION_KEY']}` })
    expect(await rewrapSecrets(rotated)).toBe(2)
    expect(await rewrapSecrets(rotated)).toBe(0)
    await expect(addWebhookEndpoint({ ...i.config, secrets: null }, i.appRef, { url: 'https://hooks.integration.test/b' })).rejects.toThrow('Set SECRETS_ENCRYPTION_KEY')

    await removeWebhookEndpoint(i.config, i.appRef, endpoint!.id)
    expect(await listWebhookEndpoints(i.config, i.appRef)).toEqual([])
    await expect(removeWebhookEndpoint(i.config, i.appRef, endpoint!.id)).rejects.toThrow(/No webhook endpoint/)
  })
})
