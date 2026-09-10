/**
 * Shared types for the built-in model inventory.
 *
 * See `index.ts` for why this inventory is kept separate from `ProviderPreset`
 * and from user-configured models.
 */
import type { ModelCapabilities, ModelModality, RequestAdapterConfig, ThinkingConfig } from '../provider'
import type { ModelCatalogDefinition, ModelCatalogVerificationStatus } from '../model-catalog'

export type ReasoningEffort = NonNullable<ThinkingConfig['defaultEffort']>

export interface ModelManufacturer {
  id: string
  label: string
  /** Search aliases used by gateways and aggregators. */
  aliases: readonly string[]
}

export interface BuiltinModelRecord {
  /** Canonical upstream model ID. */
  id: string
  /** Official vendor/family, not the configured connection. */
  manufacturerId: string
  manufacturerLabel: string
  displayName: string
  modality: ModelModality
  capabilities: ModelCapabilities
  contextWindow: number
  maxOutputTokens: number
  thinkingConfig: ThinkingConfig
  /** UI can offer these values when `thinkingConfig.mode === 'effort'`. */
  reasoningEfforts?: readonly ReasoningEffort[]
  requestAdapter?: RequestAdapterConfig
  source?: { url: string; fetchedAt: string }
  verificationStatus?: ModelCatalogVerificationStatus
  /** Alternate casing/prefixes emitted by compatible gateways. */
  aliases?: readonly string[]
  /** ID to use when looking up the official price snapshot. */
  pricingModelId?: string
}

// The catalogue domain and inventory deliberately share the same structural
// shape. Keep this compile-time assertion close to the data so a future field
// addition cannot make the UI silently drop inventory metadata.
const _definitionShape: BuiltinModelRecord extends ModelCatalogDefinition ? true : never = true
void _definitionShape
