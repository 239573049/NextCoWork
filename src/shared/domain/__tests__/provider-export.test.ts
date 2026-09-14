import { describe, expect, it } from 'vitest'
import { isProviderExport } from '../provider-export'

const provider = {
  id: 'demo', name: 'Demo', protocol: 'openai-chat', baseUrl: 'https://example.com/v1',
  credentialRef: 'provider:demo', priority: 1, enabled: true
} as const
const alias = {
  alias: 'demo-model', providerId: 'demo', upstreamModel: 'demo-model',
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  contextWindow: 4096, maxOutputTokens: 1024
} as const

describe('provider export format', () => {
  it('accepts providers, aliases, and future fields', () => {
    expect(isProviderExport({
      type: 'nextcowork-provider-export', version: 1, exportedAt: new Date().toISOString(),
      providers: [provider], aliases: [alias], future: { enabled: true }
    })).toBe(true)
  })

  it('rejects duplicate identities and aliases from another provider', () => {
    expect(isProviderExport({
      type: 'nextcowork-provider-export', version: 1, exportedAt: Date.now(),
      providers: [provider, provider], aliases: [alias]
    })).toBe(false)
    expect(isProviderExport({
      type: 'nextcowork-provider-export', version: 1, exportedAt: Date.now(),
      providers: [provider], aliases: [{ ...alias, providerId: 'other' }]
    })).toBe(false)
  })
})

