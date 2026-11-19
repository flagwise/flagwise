// Every module's migrations, in the order they run. The platform's own tables are added by migrate().

import { auditMigrations } from '@flagwise/audit'
import { casesMigrations } from '@flagwise/cases'
import { classifyMigrations } from '@flagwise/classify'
import { deliveryMigrations } from '@flagwise/delivery'
import { intakeMigrations } from '@flagwise/intake'
import type { MigrationSet } from '@flagwise/platform'
import { policyMigrations } from '@flagwise/policy'
import { privacyMigrations } from '@flagwise/privacy'
import { tenancyMigrations } from '@flagwise/tenancy'
import { triageMigrations } from '@flagwise/triage'

export const ALL_MIGRATIONS: readonly MigrationSet[] = [
  tenancyMigrations,
  // After tenancy: it takes over tenancy's config tables.
  policyMigrations,
  intakeMigrations,
  // Each policy copy starts from the policy heads on an upgrade, so after policy.
  casesMigrations,
  deliveryMigrations,
  classifyMigrations,
  triageMigrations,
  auditMigrations,
  privacyMigrations,
]
