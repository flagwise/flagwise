// The webhook sender's loop in a worker: a round of sendDueWebhooks right after one that sent
// something, else after a short wait. Rounds never overlap; stop() waits for the one in progress.

import { sendDueWebhooks, type SenderDeps, type SendOptions } from './send-webhooks.ts'

export interface WebhookSender {
  start(): void
  /** Stops after the round in progress, if any. */
  stop(): Promise<void>
}

export interface WebhookSenderOptions extends SendOptions {
  /** Wait after a round that sent nothing, or failed; default 1 000 ms. */
  readonly idleMs?: number
  readonly onError: (err: unknown) => void
}

export function createWebhookSender(deps: SenderDeps, options: WebhookSenderOptions): WebhookSender {
  const idleMs = options.idleMs ?? 1_000
  let running = false
  let loop: Promise<void> | undefined
  let wake: (() => void) | undefined
  const sleep = () => new Promise<void>((resolve) => ((wake = resolve), setTimeout(resolve, idleMs).unref()))

  const run = async () => {
    while (running) {
      let sent = 0
      try {
        sent = await sendDueWebhooks(deps, options)
      } catch (err) {
        options.onError(err)
      }
      if (sent === 0 && running) await sleep()
    }
  }

  return {
    start() {
      if (running) return
      running = true
      loop = run()
    },
    async stop() {
      running = false
      wake?.()
      await loop
    },
  }
}
