import { describe, expect, it } from 'vitest'
import { reporterCredibility } from '../src/domain/credibility.ts'

describe('reporterCredibility', () => {
  it('stays neutral below five decided reports', () => {
    expect(reporterCredibility({ upheld: 0, rejected: 0 })).toBeNull()
    expect(reporterCredibility({ upheld: 0, rejected: 4 })).toBeNull()
    expect(reporterCredibility({ upheld: 4, rejected: 0 })).toBeNull()
  })

  it('is the share of upheld reports from five on', () => {
    expect(reporterCredibility({ upheld: 5, rejected: 0 })).toBe(1)
    expect(reporterCredibility({ upheld: 0, rejected: 5 })).toBe(0)
    expect(reporterCredibility({ upheld: 3, rejected: 2 })).toBe(0.6)
    expect(reporterCredibility({ upheld: 1, rejected: 3 })).toBeNull()
    expect(reporterCredibility({ upheld: 1, rejected: 9 })).toBe(0.1)
  })

  it('uses a custom minimum', () => {
    expect(reporterCredibility({ upheld: 1, rejected: 1 }, 2)).toBe(0.5)
    expect(reporterCredibility({ upheld: 5, rejected: 4 }, 10)).toBeNull()
    expect(reporterCredibility({ upheld: 0, rejected: 0 }, 0)).toBeNull()
  })

  it.each([
    [{ upheld: -1, rejected: 5 }, 5],
    [{ upheld: 1.5, rejected: 5 }, 5],
    [{ upheld: 5, rejected: -2 }, 5],
    [{ upheld: 5, rejected: Number.NaN }, 5],
    [{ upheld: 5, rejected: 5 }, -1],
    [{ upheld: 5, rejected: 5 }, 2.5],
  ])('rejects invalid counts %o (min %s)', (history, min) => {
    expect(() => reporterCredibility(history, min)).toThrow(RangeError)
  })
})
