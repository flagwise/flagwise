// Idempotency keys for API requests: the first response to a key is kept for 24 hours and given
// again to a retry of the same request. The record is not written in the transaction of the work
// itself, so a crash between the two lets one retry run the request again.

import type { TenantRef } from '@flagwise/kernel'
import { sql } from 'drizzle-orm'
import { scopeOfRef, withTenant, type Database } from '../db/tenant.ts'

export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000
/** A key still in progress after this long belongs to a request that died; it can be taken over. */
export const IDEMPOTENCY_IN_PROGRESS_MS = 60_000

export interface StoredResponse {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

export type IdempotencyStart =
  /** The key is new (or expired): run the request, then finish() or release(). */
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  /** The key was used with a different request. */
  | { readonly kind: 'mismatch' }
  /** Another request with the key has not finished yet. */
  | { readonly kind: 'in_progress' }

/** Keys per app and mode. `fingerprint` tells a retry from another request under the same key. */
export interface IdempotencyStore {
  start(tenant: TenantRef, key: string, fingerprint: string, now: Date): Promise<IdempotencyStart>
  /** Keeps the response for replays. */
  finish(tenant: TenantRef, key: string, fingerprint: string, response: StoredResponse): Promise<void>
  /** Frees the key of a request that did not finish, so a retry runs it again. */
  release(tenant: TenantRef, key: string, fingerprint: string): Promise<void>
}

/**
 * The store on platform.idempotency_keys, each call in its own short tenant transaction. Taking a
 * key is one upsert, so two requests with the same key cannot both get 'new'. A key older than
 * the window, or in progress for longer than IDEMPOTENCY_IN_PROGRESS_MS, is taken over.
 */
export function pgIdempotencyStore(db: Database): IdempotencyStore {
  return {
    start: (tenant, key, fingerprint, now) =>
      withTenant(db, scopeOfRef(tenant), async (tx) => {
        const expired = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS)
        const stale = new Date(now.getTime() - IDEMPOTENCY_IN_PROGRESS_MS)
        const taken = await tx.execute(sql`
          INSERT INTO platform.idempotency_keys AS k (app_id, livemode, key, fingerprint, created_at)
          VALUES (${tenant.appId}, ${tenant.livemode}, ${key}, ${fingerprint}, ${now})
          ON CONFLICT (app_id, livemode, key) DO UPDATE
            SET fingerprint = EXCLUDED.fingerprint, created_at = EXCLUDED.created_at, status = NULL, content_type = NULL, body = NULL
            WHERE k.created_at < ${expired} OR (k.status IS NULL AND k.created_at < ${stale})
          RETURNING key`)
        if (taken.rows.length > 0) return { kind: 'new' }
        const found = await tx.execute(sql`
          SELECT fingerprint, status, content_type, body FROM platform.idempotency_keys
          WHERE app_id = ${tenant.appId} AND livemode = ${tenant.livemode} AND key = ${key}`)
        const row = found.rows[0] as { fingerprint: string; status: number | null; content_type: string | null; body: string | null } | undefined
        if (!row || row.fingerprint !== fingerprint) return { kind: 'mismatch' }
        if (row.status === null) return { kind: 'in_progress' }
        return { kind: 'replay', response: { status: row.status, contentType: row.content_type ?? 'application/json', body: row.body ?? '' } }
      }),

    finish: (tenant, key, fingerprint, response) =>
      withTenant(db, scopeOfRef(tenant), async (tx) => {
        await tx.execute(sql`
          UPDATE platform.idempotency_keys SET status = ${response.status}, content_type = ${response.contentType}, body = ${response.body}
          WHERE app_id = ${tenant.appId} AND livemode = ${tenant.livemode} AND key = ${key}
            AND fingerprint = ${fingerprint} AND status IS NULL`)
      }),

    release: (tenant, key, fingerprint) =>
      withTenant(db, scopeOfRef(tenant), async (tx) => {
        await tx.execute(sql`
          DELETE FROM platform.idempotency_keys
          WHERE app_id = ${tenant.appId} AND livemode = ${tenant.livemode} AND key = ${key}
            AND fingerprint = ${fingerprint} AND status IS NULL`)
      }),
  }
}
