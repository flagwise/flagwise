import { notificationsModule } from '@flagwise/notifications'
import { disputesModule } from '@flagwise/disputes'
import { auditModule } from '@flagwise/audit'
import { moderationModule } from '@flagwise/moderation'
import { classifyModule } from '@flagwise/classify'
import { deliveryModule } from '@flagwise/delivery'
import { flaggingModule } from '@flagwise/flagging'
import { analyticsModule } from '@flagwise/analytics'
import { policyModule } from '@flagwise/policy'
import { privacyModule } from '@flagwise/privacy'
import { scoringModule } from '@flagwise/scoring'
import { tenancyModule } from '@flagwise/tenancy'
import { triageModule } from '@flagwise/triage'

export const coreModules = [
  tenancyModule,
  policyModule,
  flaggingModule,
  classifyModule,
  triageModule,
  moderationModule,
  scoringModule,
  deliveryModule,
  disputesModule,
  privacyModule,
  notificationsModule,
  auditModule,
  analyticsModule,
] as const
