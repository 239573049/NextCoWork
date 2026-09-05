import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findBuiltinModel } from '../../../shared/domain/model-catalog-inventory'
import { IMPORTED_ALIAS_DEFAULTS } from '../../../shared/domain/provider'
import { closeDatabase, openDatabase } from '../../db/index'
import { getRouter, resetRuntimeForTest } from '../../runtime'
import { store } from '../../state/store'
import { windows } from '../../window/registry'
import { removeUserModelCatalog, upsertUserModelCatalog } from '../model-catalog'
import { listModels, renameModel, setAliases, updateModel, upsertProvider } from '../provider'

let dir = ''
const glm = findBuiltinModel('glm-5.3-flash')!
beforeEach(() => {
  closeDatabase()
  dir = mkdtempSync(join(tmpdir(), 'nextcowork-model-sync-'))
  openDatabase(dir)
  resetRuntimeForTest()
  upsertProvider({ id: 'relay', name: 'Relay', protocol: 'openai-chat', baseUrl: 'https://relay.invalid',
    credentialRef: '', priority: 0, enabled: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('model metadata synchronization through IPC and runtime', () => {
  it('imports capabilities, limits, thinking and adapters, using the same resolved row for runtime', () => {
    const [model] = setAliases('relay', ['z-ai/GLM-5.3-Flash'])
    expect(model).toMatchObject({ thinkingConfig: glm.thinkingConfig, reasoningEfforts: ['low', 'high', 'max'],
      capabilities: glm.capabilities, contextWindow: glm.contextWindow, maxOutputTokens: glm.maxOutputTokens })
    expect(getRouter().listModels().find((row) => row.providerId === 'relay')).toEqual(model)
  })

  it('updates existing generic imports immediately and broadcasts the resolved model after catalogue changes', () => {
    store.putAlias({ ...IMPORTED_ALIAS_DEFAULTS, alias: glm.id, upstreamModel: glm.id, providerId: 'relay' })
    const emit = vi.spyOn(windows, 'emitToAll')
    upsertUserModelCatalog({ ...glm, overrideBuiltin: true,
      thinkingConfig: { ...glm.thinkingConfig, defaultEffort: 'high' }, reasoningEfforts: ['low', 'high'],
      requestAdapter: { preset: 'auto', patches: [{ op: 'add', path: '/temperature', value: 0.3 }] } })
    const model = listModels('relay')[0]!
    expect(model.reasoningEfforts).toEqual(['low', 'high'])
    expect(model.thinkingConfig?.defaultEffort).toBe('high')
    expect(model.requestAdapter?.patches).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith('provider:changed', expect.objectContaining({ models: expect.arrayContaining([model]) }))
    expect(getRouter().listModels().find((row) => row.providerId === 'relay')).toEqual(model)
    removeUserModelCatalog(glm.id)
    expect(listModels('relay')[0]?.reasoningEfforts).toEqual(glm.reasoningEfforts)
    expect(listModels('relay')[0]?.requestAdapter).toEqual(glm.requestAdapter)
  })

  it('preserves provider overrides, renamed aliases, ordering and disabled state across resync and catalogue edits', () => {
    const [model] = setAliases('relay', [glm.id])
    updateModel({ ...model!, maxOutputTokens: 8192, enabled: false,
      thinkingConfig: { mode: 'toggle', defaultEnabled: false, parameterPath: 'enable_thinking' } })
    renameModel('relay', glm.id, 'my-glm')
    upsertUserModelCatalog({ ...glm, overrideBuiltin: true, contextWindow: 800_000,
      thinkingConfig: { ...glm.thinkingConfig, defaultEffort: 'low' }, reasoningEfforts: ['low'] })
    const rows = setAliases('relay', ['unknown', glm.id])
    expect(rows[1]).toMatchObject({ alias: 'my-glm', priority: 1, enabled: false, maxOutputTokens: 8192,
      contextWindow: 800_000, thinkingConfig: { mode: 'toggle', parameterPath: 'enable_thinking' } })
    expect(rows[0]?.thinkingConfig).toBeUndefined()
  })

  it('keeps effort parameter paths on save and rejects inconsistent supported/default efforts', () => {
    const [model] = setAliases('relay', [glm.id])
    expect(updateModel({ ...model!, thinkingConfig: { ...model!.thinkingConfig!, defaultBudgetTokens: undefined } })
      .thinkingConfig?.parameterPath).toBe('reasoning_effort')
    expect(() => updateModel({ ...model!, reasoningEfforts: ['low'] })).toThrow(/配置无效/u)
    expect(listModels('relay')[0]?.reasoningEfforts).toEqual(glm.reasoningEfforts)
  })
})
