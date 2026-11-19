// SHA-256 vectors are the standard ones for "" and "abc".
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildManifest,
  manifestBytes,
  signManifest,
  verifyPackage,
  type EvidenceManifest,
  type PackageFile,
} from '../src/domain/evidence-package.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const meta = { caseId: 'case_1', exportedBy: 'mem_admin', purpose: '  Police request 123/XI/2026  ', exportedAt: new Date('2026-11-03T09:00:00.000Z') }
const files: PackageFile[] = [
  { path: 'snapshots/rpt_1.json', bytes: enc('abc') },
  { path: 'audit.json', bytes: enc('') },
  { path: 'media/photo 1.jpg', bytes: new Uint8Array([0, 255, 1]) },
]
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')

describe('buildManifest', () => {
  it('hashes and sorts the files', () => {
    const m = buildManifest(files, meta)
    expect(m).toEqual({
      version: 1,
      case_id: 'case_1',
      exported_by: 'mem_admin',
      purpose: 'Police request 123/XI/2026',
      exported_at: '2026-11-03T09:00:00.000Z',
      files: [
        { path: 'audit.json', size: 0, sha256: SHA_EMPTY },
        { path: 'media/photo 1.jpg', size: 3, sha256: m.files[1]!.sha256 },
        { path: 'snapshots/rpt_1.json', size: 3, sha256: SHA_ABC },
      ],
    })
    expect(m.files[1]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['no files', []],
    ['an empty path', [{ path: '', bytes: enc('x') }]],
    ['an absolute path', [{ path: '/etc/passwd', bytes: enc('x') }]],
    ['a backslash', [{ path: 'media\\a.jpg', bytes: enc('x') }]],
    ['a parent segment', [{ path: 'media/../secret', bytes: enc('x') }]],
    ['a dot segment', [{ path: './a.json', bytes: enc('x') }]],
    ['an empty segment', [{ path: 'media//a.jpg', bytes: enc('x') }]],
    ['a trailing slash', [{ path: 'media/', bytes: enc('x') }]],
    ['a duplicate path', [{ path: 'a.json', bytes: enc('x') }, { path: 'a.json', bytes: enc('y') }]],
  ])('rejects %s', (_label, list) => {
    expect(() => buildManifest(list, meta)).toThrow(RangeError)
  })

  it('needs a purpose', () => {
    expect(() => buildManifest(files, { ...meta, purpose: '   ' })).toThrow(RangeError)
  })
})

describe('manifestBytes', () => {
  it('serializes in the fixed key order, whatever order the object has', () => {
    const m = buildManifest([{ path: 'a.json', bytes: enc('abc') }], meta)
    const shuffled = {
      files: [{ sha256: SHA_ABC, size: 3, path: 'a.json' }],
      exported_at: m.exported_at,
      purpose: m.purpose,
      exported_by: m.exported_by,
      case_id: m.case_id,
      version: 1,
    } as unknown as EvidenceManifest
    const expected =
      '{"version":1,"case_id":"case_1","exported_by":"mem_admin","purpose":"Police request 123/XI/2026",' +
      `"exported_at":"2026-11-03T09:00:00.000Z","files":[{"path":"a.json","size":3,"sha256":"${SHA_ABC}"}]}`
    expect(new TextDecoder().decode(manifestBytes(m))).toBe(expected)
    expect(new TextDecoder().decode(manifestBytes(shuffled))).toBe(expected)
  })
})

describe('signManifest and verifyPackage', () => {
  // Built in beforeAll, not at collection time, so an unfinished buildManifest fails these tests one by one.
  let m: EvidenceManifest
  beforeAll(() => {
    m = buildManifest(files, meta)
  })

  it('produces an Ed25519 signature over the manifest bytes', () => {
    const sig = signManifest(m, privateKey)
    expect(Buffer.from(sig, 'base64')).toHaveLength(64)
    expect(nodeVerify(null, manifestBytes(m), publicKey, Buffer.from(sig, 'base64'))).toBe(true)
  })

  it('verifies an untouched package', () => {
    expect(verifyPackage(files, m, signManifest(m, privateKey), publicKey)).toEqual({ signatureValid: true, problems: [] })
  })

  it('catches a manifest edited after signing', () => {
    const sig = signManifest(m, privateKey)
    const edited = { ...m, purpose: 'Something else' }
    expect(verifyPackage(files, edited, sig, publicKey).signatureValid).toBe(false)
  })

  it('rejects another key and a garbage signature', () => {
    const sig = signManifest(m, privateKey)
    expect(verifyPackage(files, m, sig, other.publicKey).signatureValid).toBe(false)
    expect(verifyPackage(files, m, 'not base64 !!', publicKey).signatureValid).toBe(false)
    expect(verifyPackage(files, m, '', publicKey).signatureValid).toBe(false)
  })

  it('lists file problems sorted by path', () => {
    const tampered: PackageFile[] = [
      { path: 'snapshots/rpt_1.json', bytes: enc('abd') },
      { path: 'media/photo 1.jpg', bytes: new Uint8Array([0, 255]) },
      { path: 'extra.txt', bytes: enc('x') },
    ]
    expect(verifyPackage(tampered, m, signManifest(m, privateKey), publicKey)).toEqual({
      signatureValid: true,
      problems: [
        { path: 'audit.json', problem: 'missing' },
        { path: 'extra.txt', problem: 'unexpected' },
        { path: 'media/photo 1.jpg', problem: 'size_mismatch' },
        { path: 'snapshots/rpt_1.json', problem: 'hash_mismatch' },
      ],
    })
  })
})
