import { alertsModule } from '@flagwise/alerts'
import { appealsModule } from '@flagwise/appeals'
import { auditModule } from '@flagwise/audit'
import { casesModule } from '@flagwise/cases'
import { classifyModule } from '@flagwise/classify'
import { deliveryModule } from '@flagwise/delivery'
import { intakeModule } from '@flagwise/intake'
import { metricsModule } from '@flagwise/metrics'
import { policyModule } from '@flagwise/policy'
import { privacyModule } from '@flagwise/privacy'
import { scoringModule } from '@flagwise/scoring'
import { tenancyModule } from '@flagwise/tenancy'
import { triageModule } from '@flagwise/triage'

export const coreModules = [
  tenancyModule,
  policyModule,
  intakeModule,
  classifyModule,
  triageModule,
  casesModule,
  scoringModule,
  deliveryModule,
  appealsModule,
  privacyModule,
  alertsModule,
  auditModule,
  metricsModule,
] as const
