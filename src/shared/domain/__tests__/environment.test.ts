import { describe, expect, it } from 'vitest'
import { environmentKey, isLocalEnvironment, normalizeEnvironmentRef } from '../environment'

describe('workspace environment identity', () => {
  it('keeps legacy workspaces local', () => {
    expect(normalizeEnvironmentRef(undefined)).toEqual({ kind: 'local' })
    expect(isLocalEnvironment(undefined)).toBe(true)
  })

  it.each([null, false, '', {}, { kind: 'ssh' }, { kind: 'connection' }, { kind: 'connection', connectionId: ' ' }])(
    'does not turn a malformed binding into a local environment: %j',
    (value) => expect(normalizeEnvironmentRef(value)).toEqual({ kind: 'unbound' })
  )

  it('keeps different connections and local paths in distinct namespaces', () => {
    const keys = [undefined, { kind: 'local' } as const, { kind: 'connection', connectionId: 'alpha' } as const,
      { kind: 'connection', connectionId: 'beta' } as const, { kind: 'unbound' } as const].map(environmentKey)
    expect(keys[0]).toBe(keys[1])
    expect(new Set(keys).size).toBe(4)
    expect(isLocalEnvironment({ kind: 'connection', connectionId: 'alpha' })).toBe(false)
    expect(isLocalEnvironment({ kind: 'unbound' })).toBe(false)
  })
})