// Public facade of the delivery module. Other modules import only this file.
// Owns: Tenant webhooks (outbox, retries, signatures), action results.
import { defineModule } from '@flagwise/kernel'

export const deliveryModule = defineModule({ name: 'delivery' })

export * from './app/action-requests.ts'
export * from './app/webhooks.ts'
export * from './app/send-webhooks.ts'
export * from './app/service.ts'
export * from './app/webhook-sender.ts'
export { deliveryRoutes, type ActionRequestRoutesDeps } from './api/routes.ts'
export { signatureHeaders, verify, type VerifyResult } from './domain/webhook-signature.ts'
export type { InternalEvent } from './domain/webhooks.ts'
export { RETRY_DELAYS_MS } from './domain/retry.ts'
export { pgActionRequestStore, deliveryMigrations } from './infra/pg-action-request-store.ts'
export { pgWebhookStore, pgWebhookOutbox, resealWebhookSecrets } from './infra/pg-webhook-store.ts'
export { fetchPost } from './infra/http-post.ts'
export { keyringSealer } from './infra/keyring-sealer.ts'
export { pgActionRequestReads, pgDeliveryDeps, pgSenderDeps } from './infra/pg-delivery.ts'
export { deliveryTables } from './infra/schema.ts'
