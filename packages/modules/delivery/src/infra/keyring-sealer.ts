// The SecretSealer on a platform keyring: the install's master keys.

import { open, seal, sealedKeyId, type Keyring } from '@flagwise/platform'
import type { SecretSealer } from '../app/webhooks.ts'

/** Seals with the keyring's current key and opens with any key in it; also says which key sealed a value. */
export function keyringSealer(keyring: Keyring): SecretSealer & { readonly currentKeyId: string; keyIdOf(sealed: string): string } {
  return {
    currentKeyId: keyring.current,
    seal: (plaintext, context) => seal(keyring, plaintext, context),
    open: (sealed, context) => open(keyring, sealed, context),
    keyIdOf: sealedKeyId,
  }
}
