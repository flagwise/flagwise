import { describe, expect, it } from 'vitest'
import { isUnmapped, mapsToP0, parseCategories, PRESET_NAMES, PRESETS } from '../src/index.ts'

const errorsOf = (input: unknown) => {
  const parsed = parseCategories(input)
  return parsed.ok ? [] : parsed.errors
}

describe('parseCategories', () => {
  it('reads a list in its order, trimming text and filling defaults', () => {
    expect(
      parseCategories([
        { key: 'asking_for_money', label: { en: ' Asking for money ', id: 'Minta uang' }, maps_to: ['scams_fraud'], extra: 1 },
        { key: 'fake_sugar_daddy', label: { en: 'Fake sugar daddy' }, maps_to: ['scams_fraud.romance_scam'], severity: 'P1', sla_hours: 12, enabled: false },
        { key: 'something_else', label: { en: 'Something else' } },
      ]),
    ).toEqual({
      ok: true,
      categories: [
        { key: 'asking_for_money', label: { en: 'Asking for money', id: 'Minta uang' }, mapsTo: ['scams_fraud'], severity: null, slaHours: null, enabled: true },
        { key: 'fake_sugar_daddy', label: { en: 'Fake sugar daddy', id: null }, mapsTo: ['scams_fraud.romance_scam'], severity: 'P1', slaHours: 12, enabled: false },
        { key: 'something_else', label: { en: 'Something else', id: null }, mapsTo: [], severity: null, slaHours: null, enabled: true },
      ],
    })
  })

  it('reports every bad field with its path', () => {
    expect(errorsOf({})).toEqual([{ path: 'data', message: 'A list of categories' }])
    expect(errorsOf(Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, label: { en: 'K' } })))).toEqual([{ path: 'data', message: 'At most 100 categories' }])
    expect(
      errorsOf([
        { key: 'Bad Key', label: { en: '' } },
        { key: 'dup', label: { en: 'A' }, maps_to: ['made_up'] },
        { key: 'dup', label: 'A', maps_to: ['spam', 'spam'] },
        { key: 'sev', label: { en: 'S' }, severity: 'P3', sla_hours: 0, enabled: 'yes' },
        'nope',
      ]),
    ).toEqual([
      { path: 'data[0].key', message: 'Lowercase letters, digits and underscores, starting with a letter; at most 64 characters' },
      { path: 'data[0].label.en', message: 'Text of 1 to 80 characters' },
      { path: 'data[1].maps_to[0]', message: 'Not a global group or a global category id, or listed twice' },
      { path: 'data[2].key', message: 'dup is listed twice' },
      { path: 'data[2].label', message: 'An object with en (and optionally id)' },
      { path: 'data[2].maps_to[1]', message: 'Not a global group or a global category id, or listed twice' },
      { path: 'data[3].severity', message: 'P0, P1, P2 or null' },
      { path: 'data[3].sla_hours', message: 'Whole hours from 1 to 720, or null' },
      { path: 'data[3].enabled', message: 'Must be true or false' },
      { path: 'data[4]', message: 'Must be an object' },
    ])
  })

  it('gives a custom category one global category id at most', () => {
    const message = 'A category with its own severity or SLA maps to at most one global category id'
    expect(errorsOf([{ key: 'a', label: { en: 'A' }, maps_to: ['scams_fraud'], severity: 'P1' }])).toEqual([{ path: 'data[0].maps_to', message }])
    expect(errorsOf([{ key: 'a', label: { en: 'A' }, maps_to: ['spam.spam', 'spam.fake_reviews'], sla_hours: 4 }])).toEqual([{ path: 'data[0].maps_to', message }])
    expect(errorsOf([{ key: 'a', label: { en: 'A' }, severity: 'P1' }])).toEqual([])
  })

  it('never lets a category lower a P0 global category', () => {
    expect(errorsOf([{ key: 'a', label: { en: 'A' }, maps_to: ['child_safety.grooming'], severity: 'P2' }])).toEqual([
      { path: 'data[0].severity', message: 'child_safety.grooming is a P0 category: its severity stays P0' },
    ])
    expect(errorsOf([{ key: 'a', label: { en: 'A' }, maps_to: ['child_safety.grooming'], severity: 'P0', sla_hours: 1 }])).toEqual([])
    // A disabled one only leaves the report screen: P0 detection never depends on it.
    expect(errorsOf([{ key: 'a', label: { en: 'A' }, maps_to: ['child_safety'], enabled: false }])).toEqual([])
  })
})

describe('presets', () => {
  it.each(PRESET_NAMES)('%s is a valid category list with EN and ID labels and an Other', (name) => {
    const preset = PRESETS[name]
    const api = preset.map((c) => ({ key: c.key, label: c.label, maps_to: c.mapsTo }))
    expect(parseCategories(api)).toEqual({ ok: true, categories: preset })
    expect(preset.every((c) => c.label.id !== null && !isUnmapped(c))).toBe(true)
    expect(preset.at(-1)).toMatchObject({ key: 'other', mapsTo: ['other'] })
  })

  it('tells which categories reach P0', () => {
    expect(PRESETS.dating.filter(mapsToP0).map((c) => c.key)).toEqual(['sexual_content', 'might_be_underage', 'threatening_or_dangerous', 'problem_meeting_up'])
  })
})
