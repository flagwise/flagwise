import { describe, expect, it } from 'vitest'
import { EVENT_CATALOG, NOTIFICATION_TYPES, type NotificationTypeSpec } from '../src/index.ts'

describe('the notification types', () => {
  const ownerOf = new Map<string, string>(Object.values(EVENT_CATALOG).map((e) => [e.name, e.owner]))

  it('clear each by_fact type on facts of the service that raises it, so only its owner clears it', () => {
    for (const [type, t] of Object.entries(NOTIFICATION_TYPES) as [string, NotificationTypeSpec][]) {
      if (t.clears !== 'by_fact') continue
      expect(t.clearedBy?.length, type).toBeGreaterThan(0)
      for (const fact of t.clearedBy ?? []) expect(ownerOf.get(fact), `${type}: ${fact}`).toBe(t.owner)
    }
  })

  it('name no clearing facts for a type that does not clear by fact', () => {
    for (const [type, t] of Object.entries(NOTIFICATION_TYPES) as [string, NotificationTypeSpec][]) {
      if (t.clears !== 'by_fact') expect(t.clearedBy, type).toBeUndefined()
    }
  })
})
