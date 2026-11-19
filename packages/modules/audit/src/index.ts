// Public facade of the audit module. Other modules import only this file.
// Owns: Append-only, hash-chained log of every event.
import { defineModule } from '@flagwise/kernel'

export const auditModule = defineModule({ name: 'audit' })

export * from './domain/chain.ts'
export * from './domain/events.ts'
export * from './app/audit-log.ts'
export { auditRoutes, type AuditRoutesDeps } from './api/routes.ts'
export { auditReads, subscribeAudit, type AuditServiceDeps } from './app/handlers.ts'
export { pgAuditDeps, pgAuditStore, auditMigrations } from './infra/pg-audit-store.ts'
export { auditTables } from './infra/schema.ts'
