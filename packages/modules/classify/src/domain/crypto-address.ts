// Checksums of crypto addresses: Base58Check (Bitcoin legacy and P2SH, Tron) and Bech32 / Bech32m
// (Bitcoin SegWit and Taproot, Litecoin, testnet).

import { createHash } from 'node:crypto'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const BECH32_CONST = 1
const BECH32M_CONST = 0x2bc830a3

/**
 * True when `address` is Base58 text whose decoded bytes end in the first 4 bytes of
 * SHA-256(SHA-256(the bytes before them)), and whose first byte is `version`.
 */
export function base58CheckOk(address: string, version: number): boolean {
  let n = 0n
  for (const c of address) {
    const v = BASE58.indexOf(c)
    if (v < 0) return false
    n = n * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n % 256n))
    n /= 256n
  }
  for (const c of address) {
    if (c !== '1') break
    bytes.unshift(0)
  }
  if (bytes.length !== 25 || bytes[0] !== version) return false
  const payload = Uint8Array.from(bytes.slice(0, 21))
  const check = sha256(sha256(payload))
  return bytes.slice(21).every((b, i) => b === check[i])
}

/** True when `address` is a Bech32 or Bech32m string (one case only) with a valid checksum. */
export function bech32Ok(address: string): boolean {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false
  const s = address.toLowerCase()
  const sep = s.lastIndexOf('1')
  if (sep < 1 || s.length - sep < 7 || s.length > 90) return false
  const hrp = s.slice(0, sep)
  const data = [...s.slice(sep + 1)].map((c) => BECH32.indexOf(c))
  if (data.some((d) => d < 0)) return false
  let chk = 1
  const values = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]
  for (const v of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GENERATORS[i]!
  }
  return chk === BECH32_CONST || chk === BECH32M_CONST
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
