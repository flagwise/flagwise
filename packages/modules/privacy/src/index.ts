// Public facade of the privacy module. Other modules import only this file.
// Owns: Erasure saga, identifier hashes, retention, legal hold.
import { defineModule } from '@flagwise/kernel'

export const privacyModule = defineModule({ name: 'privacy' })

export * from './app/erasure.ts'
export { privacyService, subscribePrivacy, type PrivacyService, type PrivacyServiceDeps } from './app/handlers.ts'
export { privacyRoutes, type PrivacyRoutesDeps } from './api/routes.ts'
export { pgErasureStore, pgPrivacyDeps, privacyMigrations } from './infra/pg-erasure-store.ts'
export { privacyTables } from './infra/schema.ts'
