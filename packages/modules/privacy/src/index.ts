// Public facade of the privacy module. Other modules import only this file.
// Owns: Erasure saga, identifier hashes, retention, legal hold.
import { defineModule } from '@flagwise/kernel'

export const privacyModule = defineModule({ name: 'privacy' })
