import { modelBindingResolver } from '../../shared/domain/model-binding'
import type { ModelAlias } from '../../shared/domain/provider'
import { store } from './store'

export function listResolvedModels(): ModelAlias[] {
  const resolver = modelBindingResolver(store.listUserModelCatalog())
  const rank = new Map(store.listProviders().map((p, i) => [p.id, i]))
  return store.listAliases().map(resolver.resolve).sort((a, b) =>
    (rank.get(a.providerId) ?? 1e9) - (rank.get(b.providerId) ?? 1e9) ||
    (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
    a.alias.localeCompare(b.alias)
  )
}

/** Freeze legacy ownership against the old catalogue before editing/removing it. */
export function preserveModelBindingOverrides(): void {
  const resolver = modelBindingResolver(store.listUserModelCatalog())
  for (const alias of store.listAliases()) {
    store.putAlias(resolver.resolve(alias))
  }
}
