import { describe, expect, it } from 'vitest'
import { defineModule } from '../src/index.ts'

describe('defineModule', () => {
  it('returns the definition unchanged', () => {
    const def = { name: 'cases' }
    expect(defineModule(def)).toBe(def)
  })
})
