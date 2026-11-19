// The audit log on Postgres, inside an app transaction (row-level security limits it to its
// apps and the mode).

import type { Clock, AppRef } from '@flagwise/kernel'
import { loadMigrations, scopeOfApp, withApps, type Database, type MigrationSet, type AppTx } from '@flagwise/platform'
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

export function pgAuditStore(tx: AppTx): AuditStore {
  const ofChain = (t: AppRef) => and(eq(entries.appId, t.appId), eq(entries.livemode, t.livemode))
  return {
    async lockChain(appRef, sourceEventId) {
      // A transaction-scoped advisory lock; a hash collision only makes two chains wait for each other.
      const key = `audit.chain:${appRef.appId}:${appRef.livemode}`
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
      const [recorded] = await tx.select({ seq: entries.seq }).from(entries).where(and(ofChain(appRef), eq(entries.sourceEventId, sourceEventId)))
      const [last] = await tx.select().from(entries).where(ofChain(appRef)).orderBy(sql`${entries.seq} DESC`).limit(1)
      return { last: last ? toEntry(last) : null, recorded: recorded !== undefined }
    },

    async insert(appRef, e, found) {
      await tx.insert(entries).values({
        appId: appRef.appId,
        livemode: appRef.livemode,
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

    async eraseAccount(appRef, externalId, erasedId) {
      const changed = await tx
        .update(entries)
        .set({ pii: null, piiSalt: null, subjectExternalId: erasedId })
        .where(and(ofChain(appRef), eq(entries.subjectExternalId, externalId)))
        .returning({ seq: entries.seq })
      return changed.length
    },

    async search(appRef, q) {
      const where: SQL[] = [ofChain(appRef)!]
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

    async entriesAfter(appRef, afterSeq, limit) {
      const rows = await tx.select().from(entries).where(and(ofChain(appRef), gt(entries.seq, afterSeq))).orderBy(asc(entries.seq)).limit(limit)
      return rows.map(toEntry)
    },

    async checkpoint(appRef) {
      const [row] = await tx
        .select({ seq: checkpoints.seq, hash: checkpoints.hash })
        .from(checkpoints)
        .where(and(eq(checkpoints.appId, appRef.appId), eq(checkpoints.livemode, appRef.livemode)))
      return row ?? null
    },
  }
}

/** The audit log on Postgres: each run in one app transaction. */
export function pgAuditDeps(db: Database, clock: Clock): AuditServiceDeps {
  return { run: (appRef, fn) => withApps(db, scopeOfApp(appRef), (tx) => fn(pgAuditStore(tx))), clock }
}
