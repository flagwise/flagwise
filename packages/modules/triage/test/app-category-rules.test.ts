import { describe, expect, it } from 'vitest'
import { appCategoryRule, type AppCategoryFacts } from '../src/index.ts'

const app = (o: Partial<AppCategoryFacts> = {}): AppCategoryFacts => ({ mapsTo: [], severity: null, slaHours: null, ...o })

describe('appCategoryRule', () => {
  it('is the global rule without an app category, or with a plain label', () => {
    expect(appCategoryRule('scams_fraud.romance_scam', null)).toEqual({ id: 'scams_fraud.romance_scam', severity: 'P1', p0Locked: false, suggestedActionKeys: [] })
    expect(appCategoryRule('scams_fraud.romance_scam', app({ mapsTo: ['scams_fraud'] }))).toEqual(appCategoryRule('scams_fraud.romance_scam', null))
  })

  it("takes the app category's own severity and SLA", () => {
    expect(appCategoryRule('scams_fraud.romance_scam', app({ mapsTo: ['scams_fraud.romance_scam'], severity: 'P2', slaHours: 12 }))).toEqual({
      id: 'scams_fraud.romance_scam',
      severity: 'P2',
      p0Locked: false,
      slaHours: 12,
      suggestedActionKeys: [],
    })
    expect(appCategoryRule('spam.spam', app({ mapsTo: ['spam.spam'], slaHours: 4 }))).toMatchObject({ severity: 'P2', slaHours: 4 })
    expect(appCategoryRule('other', app({ severity: 'P1' }))).toMatchObject({ id: 'other', severity: 'P1' })
  })

  it('never lowers a P0 global category', () => {
    expect(appCategoryRule('child_safety.grooming', app({ mapsTo: ['child_safety.grooming'], severity: 'P2', slaHours: 2 }))).toMatchObject({ severity: 'P0', p0Locked: true, slaHours: 2 })
  })

  it('gives a pick classified as other the least severe of what it maps to', () => {
    expect(appCategoryRule('other', app({ mapsTo: ['harassment', 'hate_speech'] }))).toEqual({ id: 'other', severity: 'P1', p0Locked: false, suggestedActionKeys: [] })
    expect(appCategoryRule('other', app({ mapsTo: ['child_safety'] }))).toMatchObject({ severity: 'P0', p0Locked: true })
    expect(appCategoryRule('other', app({ mapsTo: ['threats_violence'] }))).toMatchObject({ severity: 'P2', p0Locked: false })
    expect(appCategoryRule('other', app())).toMatchObject({ severity: 'P2' })
  })
})
