// The scoring service's composition root. It keeps nothing and handles nothing yet.

import { defineService } from '@flagwise/platform'

export const scoring = defineService({
  name: 'scoring',
  boot: () => ({}),
})
