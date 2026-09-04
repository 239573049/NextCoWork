/**
 * Vendor-first model catalogue domain helpers.
 *
 * The catalogue is deliberately separate from `ProviderPreset` and
 * `ModelAlias`.  A provider preset describes a connection (URL, protocol and
 * credentials); a model catalogue entry describes a model that exists even
 * when no connection has been configured.  `ModelAlias` is only a binding of a
 * catalogue model to one provider.
 */
import type {
  ModelAlias,
  ModelCapabilities,
  ModelModality,
  RequestAdapterConfig,
  ThinkingConfig
} from './provider'

export interface ModelCatalogSource {
  url: string
  fetchedAt: string
  verifiedAt?: string
}

/** The static metadata shipped with the application (or added by a user). */
export interface ModelCatalogDefinition {
  /** Canonical upstream model id. Keep aggregator prefixes case-sensitive. */
  id: string
  manufacturerId: string
  manufacturerLabel: string
  displayName: string
  modality: ModelModality
  capabilities: ModelCapabilities
  contextWindow: number
  maxOutputTokens: number
  thinkingConfig: ThinkingConfig
  requestAdapter?: RequestAdapterConfig
  source?: ModelCatalogSource
  /** ID used to look up a pricing row; defaults to `id`. */
  pricingModelId?: string
  /** Alternate vendor spellings accepted when matching a provider binding. */
  aliases?: readonly string[]
  /** Reasoning strengths exposed by this model/vendor combination. */
  reasoningEfforts?: readonly NonNullable<ThinkingConfig['defaultEffort']>[]
  /**
   * A user-owned metadata overlay for a bundled row.  This is deliberately
   * explicit so an accidental duplicate custom row cannot silently replace
   * the official catalogue metadata.
   */
  overrideBuiltin?: boolean
}

/** A definition supplied by a user rather than shipped in the seed catalogue. */
export type UserModelCatalogDefinition = ModelCatalogDefinition

export interface ModelCatalogEntry extends ModelCatalogDefinition {
  /** True for rows shipped in the application. */
  builtin: boolean
  /** True when the row came from user configuration. */
  custom: boolean
  /** At least one alias is bound to an AI provider. */
  configured: boolean
  /** All provider bindings for this model (a model may have several). */
  bindings: readonly ModelAlias[]
  providerIds: readonly string[]
  /** The effective enabled state for the row, when a binding exists. */
  enabled?: boolean
  /** A bundled row has a persisted user overlay waiting on top of it. */
  overridden?: boolean
}

export interface MergeModelCatalogOptions {
  builtin: readonly ModelCatalogDefinition[]
  /** User-created rows. They are appended after built-in rows. */
  custom?: readonly UserModelCatalogDefinition[]
  /** Provider×model bindings persisted by the provider service. */
  bindings?: readonly ModelAlias[]
}

/**
 * Merge the independent catalogue with provider bindings.
 *
 * Important invariants:
 *
 * - The result is never derived from provider presets or a provider's
 *   `/models` response.  A built-in row survives with zero connections.
 * - Built-in metadata is authoritative when a user accidentally creates a
 *   duplicate id. The duplicate is ignored unless it is explicitly marked as
 *   a user overlay; an overlay edits metadata without changing vendor identity.
 * - Every binding is retained.  This matters when OpenAI and an aggregator
 *   expose the same upstream id with different capabilities or pricing.
 * - No input object is mutated; nested arrays are copied for safe UI use.
 */
export function mergeModelCatalog({
  builtin,
  custom = [],
  bindings = []
}: MergeModelCatalogOptions): ModelCatalogEntry[] {
  const definitions = new Map<string, { definition: ModelCatalogDefinition; builtin: boolean }>()

  for (const definition of builtin) {
    if (!validDefinition(definition)) continue
    const key = normalizeModelId(definition.id)
    if (definitions.has(key)) continue
    definitions.set(key, { definition, builtin: true })
  }
  for (const definition of custom) {
    if (!validDefinition(definition)) continue
    const key = normalizeModelId(definition.id)
    const existing = definitions.get(key)
    if (existing === undefined) {
      definitions.set(key, { definition, builtin: false })
      continue
    }
    // An explicit overlay is the only way a user record may edit a bundled
    // row.  Keep the bundled identity/source while merging editable metadata.
    if (existing.builtin && definition.overrideBuiltin === true) {
      definitions.set(key, {
        builtin: true,
        definition: mergeDefinition(existing.definition, definition)
      })
    }
  }

  const byModel = new Map<string, ModelAlias[]>()
  for (const binding of bindings) {
    if (!binding || typeof binding.upstreamModel !== 'string') continue
    const rows = byModel.get(normalizeModelId(binding.upstreamModel)) ?? []
    rows.push(binding)
    byModel.set(normalizeModelId(binding.upstreamModel), rows)
  }

  return [...definitions.values()].map(({ definition, builtin: isBuiltin }) => {
    const rows = [definition.id, ...(definition.aliases ?? [])].flatMap(
      (id) => byModel.get(normalizeModelId(id)) ?? []
    )
    const uniqueRows = [...new Map(rows.map((row) => [`${row.providerId}\u0000${row.alias}`, row])).values()]
    const providerIds = [...new Set(uniqueRows.map((row) => row.providerId))]
    // A disabled binding should not hide an enabled binding for the same model.
    // With no binding, leave enabled undefined so the UI can show “unbound”.
    const enabled = uniqueRows.length === 0 ? undefined : uniqueRows.some((row) => row.enabled !== false)
    const customOverlay = custom.find(
      (row) => normalizeModelId(row.id) === normalizeModelId(definition.id) && row.overrideBuiltin === true
    )
    return {
      ...definition,
      capabilities: { ...definition.capabilities },
      thinkingConfig: { ...definition.thinkingConfig },
      ...(definition.requestAdapter === undefined
        ? {}
        : {
            requestAdapter: {
              ...definition.requestAdapter,
              patches: definition.requestAdapter.patches.map((patch) => ({ ...patch }))
            }
          }),
      ...(definition.source === undefined ? {} : { source: { ...definition.source } }),
      builtin: isBuiltin,
      custom: !isBuiltin,
      configured: uniqueRows.length > 0,
      bindings: uniqueRows.slice(),
      providerIds,
      ...(enabled === undefined ? {} : { enabled }),
      ...(customOverlay === undefined ? {} : { overridden: true })
    }
  })
}

/**
 * Convert a provider-discovered alias into a user catalogue row.  This is
 * useful for an explicit “Add custom model” action, but is never called while
 * merely loading a provider's model list.
 */
export function catalogDefinitionFromAlias(
  alias: ModelAlias,
  manufacturer: Pick<ModelCatalogDefinition, 'manufacturerId' | 'manufacturerLabel'>
): UserModelCatalogDefinition {
  return {
    id: alias.upstreamModel,
    manufacturerId: manufacturer.manufacturerId,
    manufacturerLabel: manufacturer.manufacturerLabel,
    displayName: alias.displayName ?? alias.alias,
    modality: alias.modality ?? 'text',
    capabilities: { ...alias.capabilities },
    contextWindow: alias.contextWindow,
    maxOutputTokens: alias.maxOutputTokens,
    thinkingConfig: alias.thinkingConfig ?? {
      mode: alias.capabilities.thinking ? 'toggle' : 'unsupported',
      defaultEnabled: false
    },
    ...(alias.requestAdapter === undefined
      ? {}
      : {
          requestAdapter: {
            ...alias.requestAdapter,
            patches: alias.requestAdapter.patches.map((patch) => ({ ...patch }))
          }
        }),
    ...(alias.source === undefined ? {} : { source: { ...alias.source } })
  }
}

/** Runtime guard for IPC/import boundaries. */
export function isModelCatalogDefinition(value: unknown): value is ModelCatalogDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const capabilities = row['capabilities']
  const thinking = row['thinkingConfig']
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    return false
  }
  const cap = capabilities as Record<string, unknown>
  if (!['tools', 'vision', 'thinking', 'caching'].every((key) => typeof cap[key] === 'boolean')) {
    return false
  }
  for (const key of [
    'textInput',
    'fileInput',
    'videoInput',
    'audioInput',
    'textOutput',
    'imageOutput',
    'videoOutput',
    'audioOutput',
    'webSearch',
    'structuredOutput',
    'streaming',
    'batch'
  ]) {
    if (cap[key] !== undefined && typeof cap[key] !== 'boolean') return false
  }
  if (typeof thinking !== 'object' || thinking === null || Array.isArray(thinking)) return false
  const tc = thinking as Record<string, unknown>
  if (
    !['unsupported', 'always', 'toggle', 'effort', 'budget'].includes(String(tc['mode'])) ||
    typeof tc['defaultEnabled'] !== 'boolean'
  ) {
    return false
  }
  if (
    tc['defaultEffort'] !== undefined &&
    !['minimal', 'low', 'medium', 'high', 'max'].includes(String(tc['defaultEffort']))
  ) {
    return false
  }
  if (
    tc['defaultBudgetTokens'] !== undefined &&
    (!Number.isInteger(tc['defaultBudgetTokens']) || Number(tc['defaultBudgetTokens']) < 0)
  ) {
    return false
  }
  const reasoningEfforts = row['reasoningEfforts']
  if (
    reasoningEfforts !== undefined &&
    (!Array.isArray(reasoningEfforts) ||
      reasoningEfforts.some(
        (effort) => !['minimal', 'low', 'medium', 'high', 'max'].includes(String(effort))
      ))
  ) {
    return false
  }
  const aliases = row['aliases']
  if (
    aliases !== undefined &&
    (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string'))
  ) {
    return false
  }
  return validDefinition(value as ModelCatalogDefinition)
}

function mergeDefinition(
  builtin: ModelCatalogDefinition,
  overlay: ModelCatalogDefinition
): ModelCatalogDefinition {
  return {
    ...builtin,
    ...overlay,
    // The canonical id and vendor identity come from the bundled record.
    id: builtin.id,
    manufacturerId: builtin.manufacturerId,
    manufacturerLabel: builtin.manufacturerLabel,
    capabilities: { ...builtin.capabilities, ...overlay.capabilities },
    thinkingConfig: { ...builtin.thinkingConfig, ...overlay.thinkingConfig },
    ...(overlay.reasoningEfforts === undefined
      ? builtin.reasoningEfforts === undefined
        ? {}
        : { reasoningEfforts: [...builtin.reasoningEfforts] }
      : { reasoningEfforts: [...overlay.reasoningEfforts] }),
    ...(overlay.requestAdapter === undefined
      ? builtin.requestAdapter === undefined
        ? {}
        : { requestAdapter: builtin.requestAdapter }
      : { requestAdapter: overlay.requestAdapter }),
    ...(overlay.source === undefined
      ? builtin.source === undefined
        ? {}
        : { source: builtin.source }
      : { source: overlay.source }),
    overrideBuiltin: true
  }
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase()
}

function validDefinition(value: ModelCatalogDefinition): boolean {
  return (
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.manufacturerId === 'string' &&
    value.manufacturerId.trim().length > 0 &&
    typeof value.displayName === 'string' &&
    value.displayName.trim().length > 0 &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow >= 0 &&
    Number.isFinite(value.maxOutputTokens) &&
    value.maxOutputTokens >= 0
  )
}
