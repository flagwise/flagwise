// Public facade of the tenancy module. Other modules import only this file.
// Owns: Apps, members, roles and API keys.
import { defineModule } from '@flagwise/kernel'

export const tenancyModule = defineModule({ name: 'tenancy' })

export * from './domain/api-keys.ts'
export * from './domain/lifecycle.ts'
export * from './domain/invitations.ts'
export * from './app/registry.ts'
export { pgTenancyStore, pgKeyDirectory, tenancyMigrations } from './infra/pg-tenancy-store.ts'
export { tenancyTables } from './infra/schema.ts'
export { busTenancyEvents } from './infra/bus-events.ts'
export { subscribeTenancy } from './app/handlers.ts'
