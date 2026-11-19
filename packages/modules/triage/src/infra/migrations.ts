import { loadMigrations, type MigrationSet } from '@flagwise/platform'

export const triageMigrations: MigrationSet = loadMigrations('triage', new URL('./migrations/', import.meta.url))
