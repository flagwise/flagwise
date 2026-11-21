// The services of the core, each booted from its own composition root (src/service.ts).

import { analytics } from '@flagwise/analytics'
import { apps } from '@flagwise/apps'
import { audit } from '@flagwise/audit'
import { auth } from '@flagwise/auth'
import { classify } from '@flagwise/classify'
import { delivery } from '@flagwise/delivery'
import { disputes } from '@flagwise/disputes'
import { flagging } from '@flagwise/flagging'
import { moderation } from '@flagwise/moderation'
import { notifications } from '@flagwise/notifications'
import { policy } from '@flagwise/policy'
import { privacy } from '@flagwise/privacy'
import { scoring } from '@flagwise/scoring'
import { triage } from '@flagwise/triage'

export const SERVICES = [apps, auth, policy, flagging, classify, triage, moderation, scoring, delivery, disputes, privacy, notifications, audit, analytics] as const
