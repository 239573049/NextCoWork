import { describe, expect, it } from 'vitest'
import { modelBindingResolver } from '../model-binding'
import { findCatalogModel, type ModelCatalogDefinition } from '../model-catalog'
import { findBuiltinModel } from '../model-catalog-inventory'
import { effectiveModelProtocol, IMPORTED_ALIAS_DEFAULTS, type ModelAlias } from '../provider'

const imported = (overrides: Partial<ModelAlias> = {}): ModelAlias => ({
  ...structuredClone(IMPORTED_ALIAS_DEFAULTS), providerId: 'relay', alias: 'glm',
  upstreamModel: 'z-ai/GLM-5.3-Flash', ...overrides
})
const glm = findBuiltinModel('glm-5.3-flash')!

describe('catalogue-backed provider metadata', () => {
  it('resolves a binding protocol override while keeping missing values inherited', () => {
    expect(effectiveModelProtocol({ protocol: 'openai-responses' }, imported())).toBe('openai-responses')
    expect(effectiveModelProtocol({ protocol: 'openai-responses' }, imported({ protocolOverride: 'anthropic' }))).toBe('anthropic')
    expect(effectiveModelProtocol({ protocol: 'openai-chat' }, imported({ protocolOverride: undefined }))).toBe('openai-chat')
  })

  it('clearing protocolOverride removes the persisted override during update', () => {
    const resolver = modelBindingResolver()
    const current = resolver.resolve(imported({ protocolOverride: 'anthropic' }))
    const cleared = resolver.update(current, { ...current, protocolOverride: undefined })
    expect(cleared.protocolOverride).toBeUndefined()
  })

  it('keeps the current override when an older metadata editor omits the field', () => {
    const resolver = modelBindingResolver()
    const current = resolver.resolve(imported({ protocolOverride: 'anthropic' }))
    const input = { ...current }
    delete (input as Partial<ModelAlias>).protocolOverride
    expect(resolver.update(current, input).protocolOverride).toBe('anthropic')
  })
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
    // ★ 这里用 caching 而不是 tools 举例:`tools: false` 曾经是目录默认值,
    // 于是旧记录上的它**无法**和「从没设过」区分开(见下一条测试)。caching 没这个历史包袱。
    const model = modelBindingResolver().resolve(imported({
      contextWindow: 64_000, maxOutputTokens: 4_000,
      capabilities: { ...IMPORTED_ALIAS_DEFAULTS.capabilities, caching: false },
      thinkingConfig: { mode: 'toggle', defaultEnabled: false, parameterPath: 'enable_thinking' }
    }))
    expect(model).toMatchObject({ contextWindow: 64_000, maxOutputTokens: 4_000,
      capabilities: { caching: false, vision: true, thinking: true }, thinkingConfig: { mode: 'toggle' } })
    expect(model.reasoningEfforts).toBeUndefined()
    expect(model.catalogOverrides).toEqual(expect.arrayContaining(['contextWindow', 'maxOutputTokens', 'thinkingConfig']))
  })

  /*
    ★★ **升级路径,不是理论问题。**
    `tools` 的目录默认值从 false 翻成了 true。旧库里每一条别名都带着按旧默认抄下的
    `tools: false`,而推断「这是不是用户自定义」的判据是「和任何默认值都不同」——
    少登记一个历史默认值,这些旧记录就会被读成「用户特意关掉了工具」并**永久钉死**,
    症状是升级完 Agent 依然没有工具,且从界面上再也改不回来。
  */
  it('不把旧目录默认值 tools:false 当成用户显式关闭', () => {
    const legacy = imported({ capabilities: { ...IMPORTED_ALIAS_DEFAULTS.capabilities, tools: false } })
    // 旧记录的判据是「catalogOverrides 缺失」
    expect(legacy.catalogOverrides).toBeUndefined()
    const model = modelBindingResolver().resolve(legacy)
    expect(model.capabilities.tools).toBe(true)
    expect(model.catalogOverrides).not.toContain('capabilities.tools')
  })

  it('用户在界面上真的关掉工具时仍然生效', () => {
    const resolver = modelBindingResolver()
    const inherited = resolver.resolve(imported({ catalogOverrides: [] }))
    expect(inherited.capabilities.tools).toBe(true)
    const edited = resolver.update(inherited, {
      ...inherited, capabilities: { ...inherited.capabilities, tools: false }
    })
    expect(edited.capabilities.tools).toBe(false)
    expect(edited.catalogOverrides).toContain('capabilities.tools')
    // 再 resolve 一次不会被目录冲掉 —— 显式设置压过目录,这正是上一条不该误判的原因
    expect(resolver.resolve(edited).capabilities.tools).toBe(false)
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
