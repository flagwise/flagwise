// The delivery service's composition root: it boots from the runtime, the master keys webhook
// secrets are sealed with, and how webhooks are posted.

import { newId } from '@flagwise/kernel'
import { defineService, type Keyring } from '@flagwise/platform'
import { deliveryRoutes } from './api/routes.ts'
import { actionSettlement, subscribeDelivery } from './app/service.ts'
import { createWebhookSender } from './app/webhook-sender.ts'
import { fetchPost } from './infra/http-post.ts'
import { keyringSealer } from './infra/keyring-sealer.ts'
import { deliveryMigrations } from './infra/pg-action-request-store.ts'
import { pgActionRequestReads, pgDeliveryDeps, pgSenderDeps } from './infra/pg-delivery.ts'

export interface DeliveryOptions {
  /** The master keys; without them no endpoint can be added, so no webhook is sent. */
  readonly secrets: Keyring | null
  /** How webhooks are posted; default fetch. */
  readonly fetch?: typeof fetch
}

/** Its handlers, its timers (action answers), the /delivery routes, and the webhook sender it starts. */
export const delivery = defineService<DeliveryOptions>({
  name: 'delivery',
  migrations: deliveryMigrations,
  boot({ db, bus, scheduler, clock, onError }, options) {
    const deps = pgDeliveryDeps(db, bus, { clock, newActionRequestId: () => newId('acr', { clock }), newEventId: () => newId('evt', { clock }) })
    subscribeDelivery(bus, deps, scheduler)
    const settlement = actionSettlement(deps)
    const sender = options.secrets ? createWebhookSender(pgSenderDeps(db, { sealer: keyringSealer(options.secrets), clock, post: fetchPost(options.fetch) }), { onError }) : undefined
    return {
      routes: deliveryRoutes({ read: pgActionRequestReads(db), confirm: settlement.confirm, fail: settlement.fail }),
      start: () => sender?.start(),
      stop: async () => sender?.stop(),
    }
  },
})
