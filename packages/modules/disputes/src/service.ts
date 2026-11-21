// The disputes service's composition root. It keeps nothing and handles nothing yet.

import { defineService } from '@flagwise/platform'

export const disputes = defineService({
  name: 'disputes',
  boot: () => ({}),
})
