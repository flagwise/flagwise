// Public facade of the apps module. Other modules import only this file.
// Owns: the install's apps and their lifecycle (delete with grace, restore); publishes app facts.

export { apps } from './service.ts'

export * from './domain/lifecycle.ts'
export * from './app/registry.ts'
export { pgAppStore, appsMigrations } from './infra/pg-app-store.ts'
export { appsTables } from './infra/schema.ts'
export { busAppEvents } from './infra/bus-events.ts'
export { subscribeApps } from './app/handlers.ts'
