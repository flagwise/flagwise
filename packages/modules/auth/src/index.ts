// Public facade of the auth module. Other modules import only this file.
// Owns: API keys and the key directory, members and roles, building the Caller; a copy of the apps.

export { auth } from './service.ts'

export * from './domain/api-keys.ts'
export * from './domain/invitations.ts'
export * from './app/keys.ts'
export { pgKeyStore, pgKeyDirectory, pgAppCopies, authMigrations } from './infra/pg-auth-store.ts'
export { authTables } from './infra/schema.ts'
export { busKeyEvents } from './infra/bus-events.ts'
export { subscribeAuth, type AuthHandlerDeps } from './app/handlers.ts'
