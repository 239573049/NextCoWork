/** User-owned model catalogue rows. Built-in rows live in shared static data. */
import type { ModelCatalogDefinition } from '../../shared/domain/model-catalog'
import { isModelCatalogDefinition } from '../../shared/domain/model-catalog'
import { store } from '../state/store'
import { windows } from '../window/registry'

/** This returns custom rows only; callers merge them with the bundled catalogue. */
export function listUserModelCatalog(): ModelCatalogDefinition[] {
  return store.listUserModelCatalog()
}

function broadcast(): void {
  windows.emitToAll('modelCatalog:changed', { custom: listUserModelCatalog() })
}

export function upsertUserModelCatalog(
  model: ModelCatalogDefinition
): ModelCatalogDefinition {
  if (!isModelCatalogDefinition(model)) throw new Error('自定义模型目录记录格式无效。')
  const normalized: ModelCatalogDefinition = {
    ...model,
    id: model.id.trim(),
    displayName: model.displayName.trim(),
    manufacturerId: model.manufacturerId.trim(),
    manufacturerLabel: model.manufacturerLabel.trim(),
    capabilities: { ...model.capabilities },
    thinkingConfig: { ...model.thinkingConfig },
    ...(model.requestAdapter === undefined
      ? {}
      : {
          requestAdapter: {
            ...model.requestAdapter,
            patches: model.requestAdapter.patches.map((patch) => ({ ...patch }))
          }
        }),
    ...(model.source === undefined ? {} : { source: { ...model.source } }),
    ...(model.reasoningEfforts === undefined
      ? {}
      : { reasoningEfforts: [...model.reasoningEfforts] }),
    ...(model.aliases === undefined ? {} : { aliases: [...model.aliases] })
  }
  const saved = store.putUserModelCatalog(normalized)
  broadcast()
  return saved
}

export function removeUserModelCatalog(id: string): void {
  const normalized = id.trim()
  if (normalized === '') throw new Error('模型 ID 不能为空。')
  store.removeUserModelCatalog(normalized)
  broadcast()
}
