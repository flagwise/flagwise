// Every module's migrations, in the order they run. The platform's own tables are added by migrate().

import { appsMigrations } from '@flagwise/apps'
import { auditMigrations } from '@flagwise/audit'
import { authMigrations } from '@flagwise/auth'
import { moderationMigrations } from '@flagwise/moderation'
import { classifyMigrations } from '@flagwise/classify'
import { deliveryMigrations } from '@flagwise/delivery'
import { flaggingMigrations } from '@flagwise/flagging'
import type { MigrationSet } from '@flagwise/platform'
import { policyMigrations } from '@flagwise/policy'
import { privacyMigrations } from '@flagwise/privacy'
import { triageMigrations } from '@flagwise/triage'

export const ALL_MIGRATIONS: readonly MigrationSet[] = [
  appsMigrations,
  authMigrations,
  policyMigrations,
  flaggingMigrations,
  moderationMigrations,
  deliveryMigrations,
  classifyMigrations,
  triageMigrations,
  auditMigrations,
  privacyMigrations,
]
