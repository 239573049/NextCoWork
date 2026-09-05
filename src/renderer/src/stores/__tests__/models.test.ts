import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelAlias, UpstreamProvider } from '../../../../shared/domain/provider'

const mocks = vi.hoisted(() => ({ listModels: vi.fn(), listProviders: vi.fn(), on: vi.fn() }))
vi.mock('../../services/provider', () => mocks)
vi.mock('../../services/ipc', () => ({ on: mocks.on }))
const provider: UpstreamProvider = { id: 'p', name: 'Provider', protocol: 'openai-chat',
  baseUrl: 'https://local.invalid', credentialRef: '', priority: 0, enabled: true }
const model: ModelAlias = { alias: 'glm', upstreamModel: 'glm', providerId: 'p',
  capabilities: { tools: true, vision: true, thinking: true, caching: true }, contextWindow: 100000, maxOutputTokens: 8192,
  thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'high' }, reasoningEfforts: ['low', 'high'] }
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

describe('live model cache', () => {
  it('keeps a newer catalogue/provider broadcast when an older initial fetch arrives late', async () => {
    let resolveModels!: (models: ModelAlias[]) => void
    mocks.listModels.mockReturnValue(new Promise<ModelAlias[]>((resolve) => { resolveModels = resolve }))
    mocks.listProviders.mockResolvedValue([provider])
    const { useModelsStore } = await import('../models')
    const pending = useModelsStore.getState().load()
    const callback = mocks.on.mock.calls.find(([event]) => event === 'provider:changed')![1]
    callback({ providers: [provider], models: [model] })
    resolveModels([{ ...model, reasoningEfforts: ['medium'] }])
    await pending
    expect(useModelsStore.getState().models[0]?.reasoningEfforts).toEqual(['low', 'high'])
    await useModelsStore.getState().load()
    expect(mocks.listModels).toHaveBeenCalledTimes(1)
  })

  it('chooses an enabled provider binding for an alias shared by several providers', async () => {
    const { useModelsStore } = await import('../models')
    useModelsStore.setState({ providers: [{ ...provider, id: 'disabled', enabled: false }, provider],
      models: [{ ...model, providerId: 'disabled', reasoningEfforts: ['max'] }, model] })
    expect(useModelsStore.getState().providerOf('glm')?.id).toBe('p')
  })
})
