import type { ModelAlias, ModelCapabilities, ModelCatalogOverride } from './provider'
import { IMPORTED_ALIAS_DEFAULTS, MODEL_METADATA_FIELDS } from './provider'
import { findCatalogModel, mergeModelCatalog, type ModelCatalogDefinition } from './model-catalog'
import { BUILTIN_MODEL_CATALOG } from './model-catalog-inventory'

/** JSON metadata equality independent of object property insertion order. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]))
  }
  const left = Object.entries(a).filter(([, v]) => v !== undefined)
  const right = Object.entries(b).filter(([, v]) => v !== undefined)
  return left.length === right.length && left.every(([key, v]) => same(v, (b as Record<string, unknown>)[key]))
}

/** One resolver for imports, settings, the composer and the runtime router. */
export function modelBindingResolver(custom: readonly ModelCatalogDefinition[] = []) {
  const catalog = mergeModelCatalog({ builtin: BUILTIN_MODEL_CATALOG, custom })

  function resolve(raw: ModelAlias): ModelAlias {
    const definition = findCatalogModel(catalog, raw.upstreamModel)
    const builtin = findCatalogModel(BUILTIN_MODEL_CATALOG, raw.upstreamModel)
    const overrides = new Set<ModelCatalogOverride>(raw.catalogOverrides)
    if (raw.catalogOverrides === undefined) {
      // Old imports stored generic placeholders; older explicit catalogue binds
      // stored a copy of the definition. Neither is a provider customization.
      for (const field of MODEL_METADATA_FIELDS) {
        const value = raw[field]
        const fallback = field in IMPORTED_ALIAS_DEFAULTS
          ? IMPORTED_ALIAS_DEFAULTS[field as 'contextWindow' | 'maxOutputTokens'] : undefined
        if (value !== undefined && !same(value, fallback) &&
          !same(value, definition?.[field]) && !same(value, builtin?.[field])) overrides.add(field)
      }
      for (const key of Object.keys(raw.capabilities) as (keyof ModelCapabilities)[]) {
        const value = raw.capabilities[key]
        if (value !== undefined && value !== IMPORTED_ALIAS_DEFAULTS.capabilities[key] &&
          value !== definition?.capabilities[key] && value !== builtin?.capabilities[key]) {
          overrides.add(`capabilities.${key}`)
        }
      }
      if (overrides.has('thinkingConfig')) overrides.add('reasoningEfforts')
    }
    const result = structuredClone(raw)
    result.catalogOverrides = [...overrides]
    if (definition !== undefined) {
      for (const field of MODEL_METADATA_FIELDS) {
        if (!overrides.has(field)) Object.assign(result, { [field]: structuredClone(definition[field]) })
      }
      result.capabilities = { ...definition.capabilities }
      for (const key of Object.keys(raw.capabilities) as (keyof ModelCapabilities)[]) {
        const value = raw.capabilities[key]
        if (overrides.has(`capabilities.${key}`) && value !== undefined) result.capabilities[key] = value
      }
    }
    // A legacy capability toggle is still an explicit provider restriction.
    if (definition !== undefined && overrides.has('capabilities.thinking') && !overrides.has('thinkingConfig')) {
      result.thinkingConfig = { mode: raw.capabilities.thinking ? 'toggle' : 'unsupported', defaultEnabled: false }
    }
    if (result.thinkingConfig !== undefined) result.capabilities.thinking = result.thinkingConfig.mode !== 'unsupported'
    if (overrides.has('capabilities.vision') && !overrides.has('capabilities.visionInput')) {
      result.capabilities.visionInput = raw.capabilities.vision
    }
    for (const field of MODEL_METADATA_FIELDS) if (result[field] === undefined) delete result[field]
    if (result.thinkingConfig !== undefined) {
      result.thinkingConfig = Object.fromEntries(Object.entries(result.thinkingConfig)
        .filter(([, value]) => value !== undefined)) as unknown as NonNullable<ModelAlias['thinkingConfig']>
    }
    return result
  }

  function update(raw: ModelAlias, input: ModelAlias): ModelAlias {
    const current = resolve(raw)
    const overrides = new Set(current.catalogOverrides)
    for (const field of MODEL_METADATA_FIELDS) {
      // Omitted properties from an older renderer do not clear saved settings.
      if (Object.hasOwn(input, field) && !same(input[field], current[field])) overrides.add(field)
    }
    for (const key of Object.keys(input.capabilities) as (keyof ModelCapabilities)[]) {
      if (!same(input.capabilities[key], current.capabilities[key])) overrides.add(`capabilities.${key}`)
    }
    if (!same(input.thinkingConfig ?? current.thinkingConfig, current.thinkingConfig) ||
      !same(input.reasoningEfforts ?? current.reasoningEfforts, current.reasoningEfforts)) {
      overrides.add('thinkingConfig')
      overrides.add('reasoningEfforts')
    }
    const next = {
      ...current, ...input,
      alias: raw.alias, providerId: raw.providerId, upstreamModel: raw.upstreamModel,
      capabilities: { ...current.capabilities, ...input.capabilities },
      catalogOverrides: [...overrides]
    }
    // Editing the legacy Think capability also changes the detailed declaration.
    if (input.capabilities.thinking !== current.capabilities.thinking && same(input.thinkingConfig, current.thinkingConfig)) {
      next.thinkingConfig = { mode: input.capabilities.thinking ? 'toggle' : 'unsupported', defaultEnabled: false }
      next.catalogOverrides = [...new Set([...overrides, 'thinkingConfig', 'reasoningEfforts'] as ModelCatalogOverride[])]
    }
    return resolve(next)
  }

  return { resolve, update }
}
