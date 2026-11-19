// The evidence package manifest: SHA-256 per file and an Ed25519 signature over the manifest, so
// anyone holding the public key can check a package without a shared secret.

import { createHash, sign, verify, type KeyObject } from 'node:crypto'

export interface PackageFile {
  readonly path: string
  readonly bytes: Uint8Array
}

export interface ManifestFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

export interface EvidenceManifest {
  readonly version: 1
  readonly case_id: string
  readonly exported_by: string
  readonly purpose: string
  readonly exported_at: string
  readonly files: readonly ManifestFile[]
}

export interface ManifestMeta {
  readonly caseId: string
  readonly exportedBy: string
  readonly purpose: string
  readonly exportedAt: Date
}

export type PackageProblem = 'missing' | 'unexpected' | 'size_mismatch' | 'hash_mismatch'

/**
 * `{ version: 1, case_id, exported_by, purpose, exported_at, files: [{ path, size, sha256 }] }`,
 * files sorted by path (plain string comparison), sha256 in lowercase hex, purpose trimmed.
 *
 * RangeError when: there are no files; a path is empty, starts with `/`, contains `\`, or has a
 * segment (split on `/`) that is empty, `.` or `..`; two files share a path; the trimmed purpose is
 * empty.
 */
export function buildManifest(_files: readonly PackageFile[], _meta: ManifestMeta): EvidenceManifest {
  if (_files.length === 0) throw new RangeError('no files')
  const seen = new Set<string>()
  for (const f of _files) {
    if (!validPath(f.path)) throw new RangeError(`invalid path: ${f.path}`)
    if (seen.has(f.path)) throw new RangeError(`duplicate path: ${f.path}`)
    seen.add(f.path)
  }
  const purpose = _meta.purpose.trim()
  if (purpose === '') throw new RangeError('purpose is empty')
  const files = _files
    .map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha256Hex(f.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    version: 1,
    case_id: _meta.caseId,
    exported_by: _meta.exportedBy,
    purpose,
    exported_at: _meta.exportedAt.toISOString(),
    files,
  }
}

/**
 * UTF-8 of JSON.stringify of the manifest with keys in exactly this order: version, case_id,
 * exported_by, purpose, exported_at, files; each file path, size, sha256. The objects are rebuilt in
 * that order, whatever order the caller's keys are in.
 */
export function manifestBytes(_manifest: EvidenceManifest): Uint8Array {
  const ordered = {
    version: _manifest.version,
    case_id: _manifest.case_id,
    exported_by: _manifest.exported_by,
    purpose: _manifest.purpose,
    exported_at: _manifest.exported_at,
    files: _manifest.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  }
  return new TextEncoder().encode(JSON.stringify(ordered))
}

/** Base64 Ed25519 signature of manifestBytes(manifest). */
export function signManifest(_manifest: EvidenceManifest, _privateKey: KeyObject): string {
  return sign(null, manifestBytes(_manifest), _privateKey).toString('base64')
}

/**
 * `signatureValid` (a malformed signature is simply invalid) and `problems`, sorted by path:
 * 'missing' (listed, not among the files), 'unexpected' (among the files, not listed),
 * 'size_mismatch' (reported instead of a hash mismatch), 'hash_mismatch' (same size, other hash).
 */
export function verifyPackage(
  _files: readonly PackageFile[],
  _manifest: EvidenceManifest,
  _signature: string,
  _publicKey: KeyObject,
): { signatureValid: boolean; problems: { path: string; problem: PackageProblem }[] } {
  let signatureValid = false
  try {
    signatureValid = verify(null, manifestBytes(_manifest), _publicKey, Buffer.from(_signature, 'base64'))
  } catch {
    signatureValid = false
  }
  const actual = new Map(_files.map((f) => [f.path, f.bytes]))
  const listed = new Set<string>()
  const problems: { path: string; problem: PackageProblem }[] = []
  for (const entry of _manifest.files) {
    listed.add(entry.path)
    const bytes = actual.get(entry.path)
    if (bytes === undefined) problems.push({ path: entry.path, problem: 'missing' })
    else if (bytes.length !== entry.size) problems.push({ path: entry.path, problem: 'size_mismatch' })
    else if (sha256Hex(bytes) !== entry.sha256) problems.push({ path: entry.path, problem: 'hash_mismatch' })
  }
  for (const path of actual.keys()) if (!listed.has(path)) problems.push({ path, problem: 'unexpected' })
  problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { signatureValid, problems }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}
