import { describe, expect, it } from 'vitest'
import { modelBindingResolver } from '../model-binding'
import { findCatalogModel, type ModelCatalogDefinition } from '../model-catalog'
import { findBuiltinModel } from '../model-catalog-inventory'
import { IMPORTED_ALIAS_DEFAULTS, type ModelAlias } from '../provider'

const imported = (overrides: Partial<ModelAlias> = {}): ModelAlias => ({
  ...structuredClone(IMPORTED_ALIAS_DEFAULTS), providerId: 'relay', alias: 'glm',
  upstreamModel: 'z-ai/GLM-5.3-Flash', ...overrides
})
const glm = findBuiltinModel('glm-5.3-flash')!

describe('catalogue-backed provider metadata', () => {
  it('enriches old generic imports, matching casing and gateway prefixes without changing binding identity', () => {
    const raw = imported({ priority: 7, enabled: false })
    const model = modelBindingResolver().resolve(raw)
    expect(model).toMatchObject({
      alias: 'glm', upstreamModel: 'z-ai/GLM-5.3-Flash', providerId: 'relay', priority: 7, enabled: false,
      thinkingConfig: { mode: 'effort', defaultEffort: 'max' }, reasoningEfforts: ['low', 'high', 'max'],
      contextWindow: glm.contextWindow, maxOutputTokens: glm.maxOutputTokens, catalogOverrides: []
    })
    expect(model.capabilities).toEqual(glm.capabilities)
    expect(raw.thinkingConfig).toBeUndefined()
    expect(raw.capabilities.thinking).toBe(false)
  })

  it('keeps identifiable legacy provider customizations while filling other metadata', () => {
    const model = modelBindingResolver().resolve(imported({
      contextWindow: 64_000, maxOutputTokens: 4_000,
      capabilities: { ...IMPORTED_ALIAS_DEFAULTS.capabilities, tools: false },
      thinkingConfig: { mode: 'toggle', defaultEnabled: false, parameterPath: 'enable_thinking' }
    }))
    expect(model).toMatchObject({ contextWindow: 64_000, maxOutputTokens: 4_000,
      capabilities: { tools: false, vision: true, thinking: true }, thinkingConfig: { mode: 'toggle' } })
    expect(model.reasoningEfforts).toBeUndefined()
    expect(model.catalogOverrides).toEqual(expect.arrayContaining(['contextWindow', 'maxOutputTokens', 'thinkingConfig']))
  })

  it('pins only edited fields and keeps thinking configuration and accepted efforts together', () => {
    const resolver = modelBindingResolver()
    const inherited = resolver.resolve(imported({ catalogOverrides: [] }))
    const customized = resolver.update(inherited, { ...inherited, maxOutputTokens: 8192,
      thinkingConfig: { ...inherited.thinkingConfig!, defaultEffort: 'low' }, reasoningEfforts: ['low', 'high'] })
    const overlay: ModelCatalogDefinition = { ...glm, overrideBuiltin: true, contextWindow: 900_000,
      displayName: 'Updated model', thinkingConfig: { ...glm.thinkingConfig, defaultEffort: 'max' }, reasoningEfforts: ['max'] }
    const updated = modelBindingResolver([overlay]).resolve(customized)
    expect(updated).toMatchObject({ maxOutputTokens: 8192, contextWindow: 900_000, displayName: 'Updated model',
      thinkingConfig: { defaultEffort: 'low' }, reasoningEfforts: ['low', 'high'] })
    expect(updated.catalogOverrides).not.toContain('contextWindow')
    expect(resolver.update(inherited, { ...inherited, enabled: false }).catalogOverrides).toEqual([])
  })

  it('does not freeze a legacy catalogue copy when a built-in overlay exists', () => {
    const copied = { ...imported(), ...glm, alias: 'glm', upstreamModel: glm.id }
    const overlay = { ...glm, overrideBuiltin: true, thinkingConfig: { ...glm.thinkingConfig, defaultEffort: 'high' as const },
      reasoningEfforts: ['low', 'high'] as const }
    expect(modelBindingResolver([overlay]).resolve(copied)).toMatchObject({
      thinkingConfig: { defaultEffort: 'high' }, reasoningEfforts: ['low', 'high'], catalogOverrides: []
    })
  })

  it('leaves unknown models at fallback values until a definition is added', () => {
    const raw = imported({ upstreamModel: 'my-custom-model', catalogOverrides: [] })
    expect(modelBindingResolver().resolve(raw).thinkingConfig).toBeUndefined()
    expect(modelBindingResolver([{ ...glm, id: raw.upstreamModel }]).resolve(raw).reasoningEfforts)
      .toEqual(['low', 'high', 'max'])
  })

  it('prefers exact ids over gateway suffixes and refuses ambiguous alias matches', () => {
    const definitions = [{ ...glm, id: 'model', displayName: 'Base' },
      { ...glm, id: 'vendor/model', displayName: 'Vendor' }]
    expect(findCatalogModel(definitions, 'vendor/model')?.displayName).toBe('Vendor')
    expect(findCatalogModel(definitions, 'gateway/vendor/model')?.displayName).toBe('Vendor')
    expect(findCatalogModel(definitions.map((d) => ({ ...d, aliases: ['ambiguous'] })), 'ambiguous')).toBeUndefined()
  })
})
