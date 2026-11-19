// The classifier guidance file: the install's own, or the one shipped with classify.

import { readFile } from 'node:fs/promises'

/** The guidance shipped with classify. */
export const DEFAULT_GUIDANCE_FILE = new URL('../../prompts/default.md', import.meta.url)

/**
 * Reads the guidance at `path`, or the shipped default without one. Throws when the file cannot be
 * read or holds only whitespace, so a wrong path never falls back to the default.
 */
export async function loadGuidance(path?: string): Promise<string> {
  const text = await readFile(path ?? DEFAULT_GUIDANCE_FILE, 'utf8')
  if (text.trim() === '') throw new TypeError(`The classifier guidance file ${path ?? DEFAULT_GUIDANCE_FILE.pathname} is empty`)
  return text
}
