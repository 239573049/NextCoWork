import { describe, expect, it } from 'vitest'
import type { ModelAlias } from '../provider'
import {
  catalogDefinitionFromAlias,
  mergeModelCatalog,
  type ModelCatalogDefinition
} from '../model-catalog'
import { BUILTIN_MODEL_CATALOG, MODEL_MANUFACTURERS } from '../model-catalog-inventory'

const definition = (id: string, manufacturerId = 'openai'): ModelCatalogDefinition => ({
  id,
  manufacturerId,
  manufacturerLabel: manufacturerId,
  displayName: id,
  modality: 'text',
  capabilities: {
    tools: true,
    vision: false,
    thinking: false,
    caching: true,
    textInput: true,
    textOutput: true,
    streaming: true
  },
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  thinkingConfig: { mode: 'unsupported', defaultEnabled: false }
})

const binding = (providerId: string, upstreamModel: string, enabled = true): ModelAlias => ({
  alias: `${providerId}-${upstreamModel}`,
  providerId,
  upstreamModel,
  capabilities: {
    tools: false,
    vision: true,
    thinking: true,
    caching: false
  },
  contextWindow: 64_000,
  maxOutputTokens: 4_096,
  enabled
})

describe('vendor-first model catalogue', () => {
  it('ships the specifically requested MiMo, Muse/HY-Muse, MiniMax and Qwen families', () => {
    const ids = new Set(BUILTIN_MODEL_CATALOG.map((row) => row.id.toLowerCase()))
    expect(ids.has('mimo-v2.5-pro')).toBe(true)
    expect(ids.has('muse-spark-1.3')).toBe(true)
    expect(ids.has('hunyuan-muse')).toBe(true)
    expect(ids.has('minimax-m3')).toBe(true)
    expect(ids.has('qwen3.8-max')).toBe(true)
    const manufacturers = new Set(MODEL_MANUFACTURERS.map((row) => row.id))
    expect(['xiaomi', 'muse', 'hunyuan', 'minimax', 'qwen'].every((id) => manufacturers.has(id))).toBe(true)
  })

  it('keeps built-in rows when there are no providers configured', () => {
    const rows = mergeModelCatalog({
      builtin: [definition('mimo-v2.5-pro', 'xiaomi'), definition('muse-spark-1.3', 'meta')]
    })

    expect(rows.map((row) => row.id)).toEqual(['mimo-v2.5-pro', 'muse-spark-1.3'])
    expect(rows.every((row) => row.configured === false)).toBe(true)
    expect(rows.every((row) => row.providerIds.length === 0)).toBe(true)
  })

  it('does not make provider preset/discovered models appear as catalogue rows', () => {
    const rows = mergeModelCatalog({
      builtin: [definition('qwen3.8-max', 'qwen')],
      // A binding for a model that is not in the catalogue is intentionally
      // ignored. The user must explicitly add it as a custom catalogue row.
      bindings: [binding('openrouter', 'provider-only-model')]
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('qwen3.8-max')
  })

  it('overlays all bindings without losing vendor metadata', () => {
    const rows = mergeModelCatalog({
      builtin: [definition('minimax-m3', 'minimax')],
      bindings: [binding('minimax', 'minimax-m3'), binding('openrouter', 'minimax-m3', false)]
    })
    const row = rows[0]

    expect(row?.manufacturerId).toBe('minimax')
    expect(row?.configured).toBe(true)
    expect(row?.providerIds).toEqual(['minimax', 'openrouter'])
    expect(row?.bindings).toHaveLength(2)
    expect(row?.enabled).toBe(true)
    expect(row?.capabilities.vision).toBe(false)
  })

  it('appends explicit user-created rows and lets built-in metadata win on duplicate ids', () => {
    const rows = mergeModelCatalog({
      builtin: [definition('qwen3.8-flash', 'qwen')],
      custom: [definition('custom-local-model', 'other'), definition('qwen3.8-flash', 'other')]
    })

    expect(rows.map((row) => row.id)).toEqual(['qwen3.8-flash', 'custom-local-model'])
    expect(rows[0]?.manufacturerId).toBe('qwen')
    expect(rows[1]?.custom).toBe(true)
  })

  it('applies only an explicitly marked user overlay to a bundled row', () => {
    const base = definition('MiniMax-M3', 'minimax')
    const rows = mergeModelCatalog({
      builtin: [base],
      custom: [
        {
          ...base,
          id: 'minimax-m3',
          displayName: '我的 MiniMax M3',
          overrideBuiltin: true,
          thinkingConfig: { mode: 'effort', defaultEnabled: true, defaultEffort: 'high' }
        }
      ]
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.builtin).toBe(true)
    expect(rows[0]?.overridden).toBe(true)
    expect(rows[0]?.displayName).toBe('我的 MiniMax M3')
    expect(rows[0]?.manufacturerId).toBe('minimax')
  })

  it('matches a provider binding through a built-in alias case-insensitively', () => {
    const base = { ...definition('MiniMax-M3', 'minimax'), aliases: ['minimax-m3'] }
    const rows = mergeModelCatalog({
      builtin: [base],
      bindings: [binding('minimax', 'minimax-m3')]
    })

    expect(rows[0]?.configured).toBe(true)
    expect(rows[0]?.providerIds).toEqual(['minimax'])
  })

  it('converts an alias to a custom row only on explicit user action', () => {
    const row = catalogDefinitionFromAlias(binding('ollama', 'muse-spark-1.3'), {
      manufacturerId: 'meta',
      manufacturerLabel: 'Meta Muse'
    })

    expect(row.id).toBe('muse-spark-1.3')
    expect(row.manufacturerId).toBe('meta')
    expect(row.thinkingConfig.mode).toBe('toggle')
    expect(row.capabilities.vision).toBe(true)
  })
})
