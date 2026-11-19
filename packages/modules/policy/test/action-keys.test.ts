import { describe, expect, it } from 'vitest'
import { parseActionKeys } from '../src/index.ts'

const warn = { key: 'warn', label: { en: 'Warn' }, categories: ['*'] }
const suspend = { key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: 'Blocks sign-in for 7 days', reverse_key: 'unsuspend', categories: ['scams_fraud', 'harassment.stalking'] }
const unsuspend = { key: 'unsuspend', label: { en: 'Lift suspension' }, categories: ['*'] }

const errorsOf = (input: unknown) => {
  const parsed = parseActionKeys(input)
  return parsed.ok ? [] : parsed.errors
}

describe('parseActionKeys', () => {
  it('reads a list in its order, trimming text and filling defaults', () => {
    const parsed = parseActionKeys([{ ...warn, label: { en: '  Warn ' }, extra: 1 }, suspend, unsuspend])
    expect(parsed).toEqual({
      ok: true,
      keys: [
        { key: 'warn', label: { en: 'Warn', id: null }, description: null, reverseKey: null, autoAllowed: false, categories: ['*'] },
        { key: 'suspend_7d', label: { en: 'Suspend 7 days', id: 'Tangguhkan 7 hari' }, description: 'Blocks sign-in for 7 days', reverseKey: 'unsuspend', autoAllowed: false, categories: ['scams_fraud', 'harassment.stalking'] },
        { key: 'unsuspend', label: { en: 'Lift suspension', id: null }, description: null, reverseKey: null, autoAllowed: false, categories: ['*'] },
      ],
    })
    expect(parseActionKeys([])).toEqual({ ok: true, keys: [] })
  })

  it('reports every bad field with its path', () => {
    expect(errorsOf({})).toEqual([{ path: 'data', message: 'A list of action keys' }])
    expect(errorsOf(Array.from({ length: 51 }, (_, i) => ({ ...warn, key: `k${i}` })))).toEqual([{ path: 'data', message: 'At most 50 action keys' }])
    expect(errorsOf([warn, 'ban', { ...warn, key: 'Ban!' }, warn]).map((e) => e.path)).toEqual(['data[1]', 'data[2].key', 'data[3].key'])
    expect(errorsOf([{ key: 'ban', label: { en: ' ', id: 'x'.repeat(81) }, description: '', categories: [] }]).map((e) => e.path)).toEqual([
      'data[0].label.en',
      'data[0].label.id',
      'data[0].description',
      'data[0].categories',
    ])
    expect(errorsOf([{ ...warn, label: 'Warn' }]).map((e) => e.path)).toEqual(['data[0].label'])
    expect(errorsOf([{ ...warn, categories: ['*', 'not_a_group'] }]).map((e) => e.path)).toEqual(['data[0].categories[1]'])
    expect(errorsOf([{ ...warn, categories: ['spam', 'spam'] }]).map((e) => e.path)).toEqual(['data[0].categories[1]'])
  })

  it('needs a reverse key from the same list, and one for an action that may run without a moderator', () => {
    expect(errorsOf([suspend])).toEqual([{ path: 'data[0].reverse_key', message: 'unsuspend is not in the list' }])
    expect(errorsOf([{ ...warn, reverse_key: 'warn' }])).toEqual([{ path: 'data[0].reverse_key', message: 'An action cannot reverse itself' }])
    expect(errorsOf([{ ...warn, reverse_key: 7 }]).map((e) => e.path)).toEqual(['data[0].reverse_key'])
    expect(errorsOf([{ ...warn, auto_allowed: true }]).map((e) => e.path)).toEqual(['data[0].auto_allowed'])
    expect(errorsOf([{ ...warn, auto_allowed: 'yes' }]).map((e) => e.path)).toEqual(['data[0].auto_allowed'])
    const hide = { key: 'hide_content', label: { en: 'Hide content' }, reverse_key: 'show_content', auto_allowed: true, categories: ['*'] }
    expect(errorsOf([hide, { key: 'show_content', label: { en: 'Show content' }, categories: ['*'] }])).toEqual([])
  })
})
