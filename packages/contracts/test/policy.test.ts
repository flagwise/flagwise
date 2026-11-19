import { describe, expect, it } from 'vitest'
import { allowedActionKeys, allowsCategory, DEFAULT_POLICY, eventContract, isActionKeyCategory, policyCategory, type Policy } from '../src/index.ts'

const key = (k: string, categories: readonly string[]) => ({ key: k, label: { en: k, id: null }, description: null, reverseKey: null, autoAllowed: false, categories })
const POLICY: Policy = {
  categories: [
    { key: 'asking_for_money', label: { en: 'Asking for money', id: 'Minta uang' }, mapsTo: ['scams_fraud'], severity: null, slaHours: null, enabled: true },
    { key: 'old_pick', label: { en: 'Old pick', id: null }, mapsTo: [], severity: null, slaHours: null, enabled: false },
  ],
  actionKeys: [key('warn', ['*']), key('suspend_7d', ['scams_fraud', 'harassment.stalking']), key('unsuspend', ['*'])],
  llm: { rulesOnly: false, fallbackToRules: true },
}

describe('allowsCategory', () => {
  it('matches every category, a group or one category id, and only global categories', () => {
    expect(allowsCategory(['*'], 'spam.spam')).toBe(true)
    expect(allowsCategory(['*'], 'other')).toBe(true)
    expect(allowsCategory(['scams_fraud'], 'scams_fraud.romance_scam')).toBe(true)
    expect(allowsCategory(['scams_fraud.romance_scam'], 'scams_fraud.romance_scam')).toBe(true)
    expect(allowsCategory(['scams_fraud.romance_scam'], 'scams_fraud.phishing')).toBe(false)
    expect(allowsCategory(['*'], 'asking_for_money')).toBe(false)
  })

  it('names what an action key may list', () => {
    expect(['*', 'scams_fraud', 'spam.spam'].map(isActionKeyCategory)).toEqual([true, true, true])
    expect(['', 'not_a_group', 'asking_for_money'].map(isActionKeyCategory)).toEqual([false, false, false])
  })
})

describe('allowedActionKeys', () => {
  it("lists the policy's keys that allow the category, in its order, and null for a category outside the taxonomy", () => {
    expect(allowedActionKeys(POLICY, 'scams_fraud.romance_scam')).toEqual(['warn', 'suspend_7d', 'unsuspend'])
    expect(allowedActionKeys(POLICY, 'spam.spam')).toEqual(['warn', 'unsuspend'])
    expect(allowedActionKeys(POLICY, 'asking_for_money')).toBeNull()
    expect(allowedActionKeys(DEFAULT_POLICY, 'other')).toEqual([])
  })
})

describe('policyCategory', () => {
  it('finds a current category by its key, disabled ones too', () => {
    expect(policyCategory(POLICY, 'asking_for_money')?.mapsTo).toEqual(['scams_fraud'])
    expect(policyCategory(POLICY, 'old_pick')?.enabled).toBe(false)
    expect(policyCategory(POLICY, 'gone')).toBeNull()
  })
})

describe('policy.updated', () => {
  const updated = { appId: 'app_jane', version: 3, policy: POLICY, occurredAt: '2026-11-18T09:30:00.000Z' }

  it('carries the whole policy with a version counting from 1', () => {
    expect(eventContract.versionOf('policy.updated.v1', updated)).toBe('1.0.0')
    expect(eventContract.versionOf('policy.updated.v1', { ...updated, policy: DEFAULT_POLICY })).toBe('1.0.0')
    expect(() => eventContract.versionOf('policy.updated.v1', { ...updated, version: 0 })).toThrow(/version/)
    expect(() => eventContract.versionOf('policy.updated.v1', { ...updated, version: 1.5 })).toThrow(/version/)
    expect(() => eventContract.versionOf('policy.updated.v1', { ...updated, policy: { ...POLICY, llm: { rulesOnly: true } } })).toThrow(/fallbackToRules/)
  })
})
