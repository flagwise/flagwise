// The analytics service's composition root. It keeps nothing and handles nothing yet.

import { defineService } from '@flagwise/platform'

export const analytics = defineService({
  name: 'analytics',
  boot: () => ({}),
})
