// Public facade of the scoring module. Other modules import only this file.
// Owns: Violation score and ledger, reporter credibility, account-age weighting.
import { defineModule } from '@flagwise/kernel'

export const scoringModule = defineModule({ name: 'scoring' })
