// Scenario 8: erasing a subject everywhere and reporting its status. Pending: the privacy module
// has the erasure rules, but the server exposes no erasure route and runs no erasure flow yet, so
// there is no behaviour to guard. Phase 1 item 9 (erasure with acks) builds it; this file then
// turns into a real scenario.
import { describe, it } from 'vitest'

describe('erasure', () => {
  it.todo('erases a subject in every service that holds its data and reports each one as done')
  it.todo('reports a service that is down as pending, not as done')
})
