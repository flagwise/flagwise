import { GLOBAL_CATEGORIES } from '@flagwise/contracts'
import { describe, expect, it } from 'vitest'
import { globalCategoryRule } from '../src/index.ts'

describe('globalCategoryRule', () => {
  it('takes the severity of each global category, locking the P0 ones', () => {
    for (const c of GLOBAL_CATEGORIES) {
      expect(globalCategoryRule(c.id)).toEqual({ id: c.id, severity: c.severity, p0Locked: c.severity === 'P0', suggestedActionKeys: [] })
    }
    expect(globalCategoryRule('offline_behavior.physical_violence')).toMatchObject({ severity: 'P0', p0Locked: true })
  })

  it('gives a category outside the taxonomy the rule of other', () => {
    expect(globalCategoryRule('asking_for_money')).toEqual({ id: 'other', severity: 'P2', p0Locked: false, suggestedActionKeys: [] })
  })
})
