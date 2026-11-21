import { describe, expect, it } from 'vitest'
import { createApp } from '../src/index.ts'

describe('createApp', () => {
  it('serves /healthz', async () => {
    const res = await createApp().http.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('serves /readyz from the readiness check', async () => {
    expect((await createApp().http.request('/readyz')).status).toBe(200)
    expect((await createApp({ ready: async () => {} }).http.request('/readyz')).status).toBe(200)
    const down = await createApp({ ready: async () => Promise.reject(new Error('database down')) }).http.request('/readyz')
    expect(down.status).toBe(503)
    expect(await down.json()).toEqual({ status: 'unavailable' })
  })

  it('has the fourteen core services', () => {
    expect(createApp().services.map((s) => s.name)).toHaveLength(14)
  })

  it('registers every plugin it is given', () => {
    const registered: string[] = []
    createApp({ plugins: [{ name: 'p', register: () => void registered.push('p') }] })
    expect(registered).toEqual(['p'])
  })
})
