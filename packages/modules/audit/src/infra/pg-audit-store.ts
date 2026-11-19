// The audit log on Postgres, inside a tenant transaction (row-level security limits it to that
// org, its apps and the mode).

import type { Clock, TenantRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfRef, withTenant, type Database, type MigrationSet, type TenantTx } from '@flagwise/platform'
import { and, asc, eq, gt, gte, lt, sql, type SQL } from 'drizzle-orm'
import type { AuditStore } from '../app/audit-log.ts'
import type { AuditServiceDeps } from '../app/handlers.ts'
import type { AuditEntry, Json } from '../domain/chain.ts'
import { checkpointsTable as checkpoints, entriesTable as entries } from './schema.ts'

export const auditMigrations: MigrationSet = loadMigrations('audit', new URL('./migrations/', import.meta.url))

type Facts = { readonly [key: string]: Json }

const toEntry = (r: typeof entries.$inferSelect): AuditEntry => ({
  seq: r.seq,
  at: r.at.toISOString(),
  actor: { type: r.actorType, id: r.actorId },
  action: r.action,
  target: { type: r.targetType, id: r.targetId },
  facts: r.facts as Facts,
  pii: (r.pii as Facts | null) ?? null,
  piiSalt: r.piiSalt,
  piiDigest: r.piiDigest,
  prevHash: r.prevHash,
  hash: r.hash,
})

export function pgAuditStore(tx: TenantTx): AuditStore {
  const ofChain = (t: TenantRef) => and(eq(entries.orgId, t.orgId), eq(entries.appId, t.appId), eq(entries.livemode, t.livemode))
  return {
    async lockChain(tenant, sourceEventId) {
      // A transaction-scoped advisory lock; a hash collision only makes two chains wait for each other.
      const key = `audit.chain:${tenant.orgId}:${tenant.appId}:${tenant.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
      const [recorded] = await tx.select({ seq: entries.seq }).from(entries).where(and(ofChain(tenant), eq(entries.sourceEventId, sourceEventId)))
      const [last] = await tx.select().from(entries).where(ofChain(tenant)).orderBy(sql`${entries.seq} DESC`).limit(1)
      return { last: last ? toEntry(last) : null, recorded: recorded !== undefined }
    },

    async insert(tenant, e, found) {
      await tx.insert(entries).values({
        orgId: tenant.orgId,
        appId: tenant.appId,
        livemode: tenant.livemode,
        seq: e.seq,
        at: new Date(e.at),
        actorType: e.actor.type,
        actorId: e.actor.id,
        action: e.action,
        targetType: e.target.type,
        targetId: e.target.id,
        facts: e.facts,
        pii: e.pii,
        piiSalt: e.piiSalt,
        piiDigest: e.piiDigest,
        prevHash: e.prevHash,
        hash: e.hash,
        sourceEventId: found.sourceEventId,
        caseId: found.caseId,
        subjectExternalId: found.subjectExternalId,
      })
    },

    async search(tenant, q) {
      const where: SQL[] = [ofChain(tenant)!]
      if (q.actorId !== undefined) where.push(eq(entries.actorId, q.actorId))
      if (q.caseId !== undefined) where.push(eq(entries.caseId, q.caseId))
      if (q.subjectExternalId !== undefined) where.push(eq(entries.subjectExternalId, q.subjectExternalId))
      if (q.from !== undefined) where.push(gte(entries.at, q.from))
      if (q.to !== undefined) where.push(lt(entries.at, q.to))
      if (q.afterSeq !== undefined) where.push(gt(entries.seq, q.afterSeq))
      const rows = await tx.select().from(entries).where(and(...where)).orderBy(asc(entries.seq)).limit(q.limit + 1)
      const data = rows.slice(0, q.limit).map(toEntry)
      return { data, nextAfterSeq: rows.length > q.limit ? data[data.length - 1]!.seq : null }
    },

    async entriesAfter(tenant, afterSeq, limit) {
      const rows = await tx.select().from(entries).where(and(ofChain(tenant), gt(entries.seq, afterSeq))).orderBy(asc(entries.seq)).limit(limit)
      return rows.map(toEntry)
    },

    async checkpoint(tenant) {
      const [row] = await tx
        .select({ seq: checkpoints.seq, hash: checkpoints.hash })
        .from(checkpoints)
        .where(and(eq(checkpoints.orgId, tenant.orgId), eq(checkpoints.appId, tenant.appId), eq(checkpoints.livemode, tenant.livemode)))
      return row ?? null
    },
  }
}

/** The audit log on Postgres: each run in one tenant transaction. */
export function pgAuditDeps(db: Database, clock: Clock): AuditServiceDeps {
  return { run: (tenant, fn) => withTenant(db, scopeOfRef(tenant), (tx) => fn(pgAuditStore(tx))), clock }
}
