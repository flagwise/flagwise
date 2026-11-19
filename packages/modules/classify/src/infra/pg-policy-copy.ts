// Classify's copy of each app's policy on Postgres, kept from policy.updated.

import type { Policy } from '@flagwise/contracts'
import { pgDocumentCopy, type Database, type DocumentCopy } from '@flagwise/platform'
import { policyCopiesTable } from './schema.ts'

export function pgClassifyPolicyCopy(db: Database): DocumentCopy<Policy> {
  return pgDocumentCopy<Policy>(db, policyCopiesTable)
}
