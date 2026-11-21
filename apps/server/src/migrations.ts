// Every service's migrations, in the order of SERVICES. The platform's own tables are added by migrate().

import type { MigrationSet } from '@flagwise/platform'
import { SERVICES } from './modules.ts'

export const ALL_MIGRATIONS: readonly MigrationSet[] = SERVICES.flatMap((s) => (s.migrations ? [s.migrations] : []))
