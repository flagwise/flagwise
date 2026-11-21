// Checks a webhook's signature the way the tenant's backend does, by the Standard Webhooks spec,
// written apart from Flagwise's own signing code so the scenarios check what a tenant can rely on.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Webhook } from './net.ts'

/** Whether one of the `v1,` signatures is the HMAC-SHA256 of `{id}.{timestamp}.{body}` with the secret. */
export function signedWith(secret: string, hook: Webhook): boolean {
  const id = hook.headers['webhook-id']
  const timestamp = hook.headers['webhook-timestamp']
  const signatures = hook.headers['webhook-signature']
  if (!id || !timestamp || !signatures || !secret.startsWith('whsec_')) return false
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${hook.body}`).digest('base64'))
  return signatures.split(' ').some((s) => {
    const given = Buffer.from(s.startsWith('v1,') ? s.slice(3) : '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
