/**
 * Built-in model inventory.
 *
 * This is deliberately separate from `ProviderPreset` and from the models a
 * user has configured.  A provider preset describes a connection (URL,
 * protocol and credentials); this file describes the models that exist in the
 * vendor catalogue.  Keeping those axes separate means the model-management
 * page can show every known model before a connection has been added.
 *
 * The inventory is a curated, versioned snapshot.  It is intentionally free
 * of user secrets and runtime provider state.  IDs are the IDs used by the
 * vendors where known; aliases cover the spelling used by compatible gateways.
 */
import type {
  ModelCapabilities,
  ModelModality,
  RequestAdapterConfig,
  ThinkingConfig,
} from './provider'
import type { ModelCatalogDefinition } from './model-catalog'

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

export const MODEL_CATALOG_FETCHED_AT = '2026-09-05'

/**
 * Vendor families shown in the model-management sidebar.  Do not add a
 * configured-provider entry here: this list is about model manufacturers.
 */
export const MODEL_MANUFACTURERS: readonly ModelManufacturer[] = [
  { id: 'openai', label: 'OpenAI', aliases: ['openai', 'gpt', 'chatgpt'] },
  { id: 'anthropic', label: 'Anthropic', aliases: ['anthropic', 'claude'] },
  { id: 'google', label: 'Google', aliases: ['google', 'gemini', 'gemma', 'vertex'] },
  { id: 'deepseek', label: 'DeepSeek', aliases: ['deepseek', 'deep-seek'] },
  { id: 'zhipu', label: '智谱 GLM', aliases: ['zhipu', 'z.ai', 'glm', 'chatglm'] },
  { id: 'qwen', label: '阿里云 Qwen', aliases: ['qwen', 'qwq', 'tongyi', '通义', 'dashscope'] },
  { id: 'moonshot', label: 'Moonshot / Kimi', aliases: ['moonshot', 'kimi', '月之暗面'] },
  { id: 'xai', label: 'xAI Grok', aliases: ['xai', 'grok'] },
  { id: 'mistral', label: 'Mistral AI', aliases: ['mistral', 'mixtral', 'codestral', 'devstral', 'pixtral'] },
  { id: 'cohere', label: 'Cohere', aliases: ['cohere', 'command'] },
  { id: 'minimax', label: 'MiniMax', aliases: ['minimax', 'abab'] },
  { id: 'hunyuan', label: '腾讯混元 / Hunyuan', aliases: ['hunyuan', '腾讯混元', 'hy-muse'] },
  { id: 'xiaomi', label: '小米 MiMo', aliases: ['xiaomi', 'mimo', '小米'] },
  { id: 'muse', label: 'Muse', aliases: ['muse', 'muse-spark', 'muse-glimmer'] },
  { id: 'doubao', label: '字节跳动豆包 / Doubao', aliases: ['doubao', 'seed', 'seedream', 'seedance'] },
  { id: 'baidu', label: '百度文心 / ERNIE', aliases: ['baidu', 'ernie', 'wenxin', '文心'] },
  { id: 'stepfun', label: '阶跃星辰 StepFun', aliases: ['stepfun', 'step-', '阶跃'] },
  { id: 'baichuan', label: '百川智能', aliases: ['baichuan', '百川'] },
  { id: 'sensenova', label: '商汤 SenseNova', aliases: ['sensenova', 'sensechat', '商汤', '日日新'] },
  { id: 'spark', label: '讯飞星火', aliases: ['spark', 'xfyun', '讯飞', '星火'] },
  { id: 'yi', label: '零一万物 Yi', aliases: ['yi-', '01.ai', '零一万物'] },
  { id: 'meta', label: 'Meta Llama', aliases: ['meta', 'llama'] },
  { id: 'microsoft', label: 'Microsoft Phi', aliases: ['microsoft', 'phi'] },
  { id: 'amazon', label: 'Amazon Nova', aliases: ['amazon', 'nova', 'bedrock'] },
  { id: 'ai21', label: 'AI21 Labs Jamba', aliases: ['ai21', 'jamba'] },
  { id: 'perplexity', label: 'Perplexity', aliases: ['perplexity', 'sonar'] },
  { id: 'internlm', label: '上海人工智能实验室 InternLM', aliases: ['internlm', 'internvl'] },
  { id: 'other', label: '其他厂商', aliases: [] },
]

const MANUFACTURER_BY_ID = new Map(MODEL_MANUFACTURERS.map((m) => [m.id, m]))

/** Resolve a vendor family from a model ID, including aggregator prefixes. */
export function manufacturerForModelId(modelId: string): ModelManufacturer {
  const value = modelId.trim()
  const segments = value.split('/').filter(Boolean)
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    for (const manufacturer of MODEL_MANUFACTURERS) {
      if (manufacturer.id === 'other') continue
      if (
        manufacturer.aliases.some((alias) => {
          const a = alias.toLowerCase()
          if (a === 'step-') return lower.startsWith(a)
          if (a === 'yi-') return lower.startsWith(a)
          return lower === a || lower.startsWith(`${a}-`) || lower.startsWith(`${a}:`)
        })
      ) {
        return manufacturer
      }
    }
  }
  return MANUFACTURER_BY_ID.get('other')!
}

const source = (url: string): { url: string; fetchedAt: string } => ({
  url,
  fetchedAt: MODEL_CATALOG_FETCHED_AT,
})

const SOURCES = {
  openai: source('https://openai.com/api/pricing'),
  anthropic: source('https://www.anthropic.com/pricing'),
  google: source('https://ai.google.dev/gemini-api/docs/models'),
  deepseek: source('https://api-docs.deepseek.com/'),
  zhipu: source('https://docs.z.ai/guides/overview/models'),
  qwen: source('https://help.aliyun.com/zh/model-studio/models'),
  moonshot: source('https://platform.moonshot.cn/docs/intro'),
  xai: source('https://docs.x.ai/docs/models'),
  mistral: source('https://docs.mistral.ai/getting-started/models/'),
  cohere: source('https://docs.cohere.com/docs/models'),
  minimax: source('https://platform.minimax.io/docs/guides/models'),
  hunyuan: source('https://cloud.tencent.com/document/product/1729'),
  xiaomi: source('https://platform.mimo.ai/'),
  muse: source('https://www.muse.ai/'),
  doubao: source('https://www.volcengine.com/docs/82379'),
  baidu: source('https://cloud.baidu.com/doc/WENXINWORKSHOP/s/jlil56u11'),
  stepfun: source('https://platform.stepfun.com/docs/overview'),
  baichuan: source('https://platform.baichuan-ai.com/docs/api'),
  sensenova: source('https://console.sensecore.cn/help/docs/model-as-a-service/nova'),
  spark: source('https://www.xfyun.cn/doc/spark/Web.html'),
  yi: source('https://platform.lingyiwanwu.com/docs'),
  meta: source('https://www.llama.com/docs/model-cards-and-prompt-formats/'),
  microsoft: source('https://learn.microsoft.com/azure/ai-studio/how-to/deploy-models-phi-3'),
  amazon: source('https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html'),
  ai21: source('https://docs.ai21.com/docs/jamba-models'),
  perplexity: source('https://docs.perplexity.ai/getting-started/models'),
  internlm: source('https://internlm.intern-ai.org.cn/'),
} as const

const efforts = ['minimal', 'low', 'medium', 'high', 'max'] as const

const textCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  tools: true,
  vision: false,
  thinking: false,
  caching: true,
  textInput: true,
  fileInput: false,
  videoInput: false,
  audioInput: false,
  textOutput: true,
  imageOutput: false,
  videoOutput: false,
  audioOutput: false,
  webSearch: false,
  structuredOutput: true,
  streaming: true,
  batch: false,
  ...overrides,
})

const visionCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({ vision: true, fileInput: true, ...overrides })

const imageCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({
    tools: false,
    textInput: true,
    textOutput: false,
    imageOutput: true,
    structuredOutput: false,
    ...overrides,
  })

const videoCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({
    tools: false,
    textOutput: false,
    videoOutput: true,
    structuredOutput: false,
    ...overrides,
  })

const audioCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({
    tools: false,
    textOutput: false,
    audioOutput: true,
    structuredOutput: false,
    ...overrides,
  })

const unsupportedThinking: ThinkingConfig = { mode: 'unsupported', defaultEnabled: false }
const toggleThinking = (parameterPath = 'thinking'): ThinkingConfig => ({
  mode: 'toggle',
  defaultEnabled: false,
  parameterPath,
})
const effortThinking = (parameterPath: string, defaultEffort: ReasoningEffort = 'medium'): ThinkingConfig => ({
  mode: 'effort',
  defaultEnabled: true,
  defaultEffort,
  parameterPath,
})
const budgetThinking = (parameterPath: string, budget = 32_768): ThinkingConfig => ({
  mode: 'budget',
  defaultEnabled: true,
  defaultBudgetTokens: budget,
  parameterPath,
})
const alwaysThinking = (parameterPath = 'enable_thinking'): ThinkingConfig => ({
  mode: 'always',
  defaultEnabled: true,
  parameterPath,
})

type ModelOptions = {
  modality?: ModelModality
  capabilities?: ModelCapabilities
  contextWindow?: number
  maxOutputTokens?: number
  thinkingConfig?: ThinkingConfig
  reasoningEfforts?: readonly ReasoningEffort[]
  requestAdapter?: RequestAdapterConfig
  aliases?: readonly string[]
  pricingModelId?: string
}

function manufacturer(id: string): ModelManufacturer {
  return MANUFACTURER_BY_ID.get(id) ?? MANUFACTURER_BY_ID.get('other')!
}

function model(
  manufacturerId: string,
  id: string,
  displayName: string,
  options: ModelOptions = {},
): BuiltinModelRecord {
  const m = manufacturer(manufacturerId)
  const capabilities = options.capabilities ?? textCapabilities()
  const thinkingConfig =
    options.thinkingConfig ?? (capabilities.thinking ? toggleThinking() : unsupportedThinking)
  return {
    id,
    manufacturerId: m.id,
    manufacturerLabel: m.label,
    displayName,
    modality: options.modality ?? 'text',
    capabilities,
    contextWindow: options.contextWindow ?? 200_000,
    maxOutputTokens: options.maxOutputTokens ?? 16_384,
    thinkingConfig,
    ...(options.reasoningEfforts === undefined ? {} : { reasoningEfforts: options.reasoningEfforts }),
    ...(options.requestAdapter === undefined ? {} : { requestAdapter: options.requestAdapter }),
    source: SOURCES[m.id as keyof typeof SOURCES],
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    pricingModelId: options.pricingModelId ?? id,
  }
}

const OPENAI: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-5.6-astra', 'GPT-5.6 Astra', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.5', 'GPT-5.5', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.4', 'GPT-5.4', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.4-nano', 'GPT-5.4 nano', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.4-pro', 'GPT-5.4 Pro', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.2', 'GPT-5.2', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.2-pro', 'GPT-5.2 Pro', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5.1', 'GPT-5.1', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5', 'GPT-5', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5-mini', 'GPT-5 mini', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-5-nano', 'GPT-5 nano', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('openai', 'gpt-4.1', 'GPT-4.1', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('openai', 'gpt-4.1-nano', 'GPT-4.1 nano', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('openai', 'gpt-4o', 'GPT-4o', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('openai', 'gpt-4o-mini', 'GPT-4o mini', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('openai', 'o1', 'o1', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_effort', 32_768), reasoningEfforts: efforts }),
  model('openai', 'o1-pro', 'o1 Pro', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_effort', 64_000), reasoningEfforts: efforts }),
  model('openai', 'o3', 'o3', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_effort', 32_768), reasoningEfforts: efforts }),
  model('openai', 'o3-pro', 'o3 Pro', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_effort', 64_000), reasoningEfforts: efforts }),
  model('openai', 'o3-mini', 'o3 mini', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_effort', 16_384), reasoningEfforts: efforts }),
  model('openai', 'o4-mini', 'o4 mini', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_effort', 16_384), reasoningEfforts: efforts }),
  model('openai', 'gpt-4-turbo', 'GPT-4 Turbo', { capabilities: visionCapabilities() }),
  model('openai', 'gpt-3.5-turbo', 'GPT-3.5 Turbo'),
]

const ANTHROPIC: readonly BuiltinModelRecord[] = [
  model('anthropic', 'claude-opus-5', 'Claude Opus 5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000) }),
  model('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000) }),
  model('anthropic', 'claude-mythos-5-1', 'Claude Mythos 5.1', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000) }),
  model('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000) }),
  model('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000) }),
  model('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000) }),
  model('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000) }),
  model('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000) }),
  model('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000) }),
  model('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000) }),
  model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000) }),
  model('anthropic', 'claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000), aliases: ['claude-3-7-sonnet-20250219'] }),
  model('anthropic', 'claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', { capabilities: visionCapabilities(), aliases: ['claude-3-5-sonnet-20241022'] }),
  model('anthropic', 'claude-3-5-haiku-latest', 'Claude 3.5 Haiku', { capabilities: visionCapabilities(), aliases: ['claude-3-5-haiku-20241022'] }),
]

const GOOGLE: readonly BuiltinModelRecord[] = [
  model('google', 'gemini-3.8-pro', 'Gemini 3.8 Pro', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-3.1-pro', 'Gemini 3.1 Pro', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('thinkingConfig.thinkingLevel'), reasoningEfforts: efforts }),
  model('google', 'gemini-2.0-flash', 'Gemini 2.0 Flash', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('google', 'gemini-1.5-pro', 'Gemini 1.5 Pro', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('google', 'gemini-1.5-flash', 'Gemini 1.5 Flash', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('google', 'gemma-3-27b-it', 'Gemma 3 27B', { capabilities: visionCapabilities() }),
  model('google', 'gemma-3-12b-it', 'Gemma 3 12B', { capabilities: visionCapabilities() }),
  model('google', 'gemma-3-4b-it', 'Gemma 3 4B', { capabilities: visionCapabilities() }),
]

const DEEPSEEK: readonly BuiltinModelRecord[] = [
  model('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_768) }),
  model('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 16_384) }),
  model('deepseek', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (实验)', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 16_384) }),
  model('deepseek', 'deepseek-r1', 'DeepSeek R1', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 32_768), aliases: ['deepseek-reasoner'] }),
  model('deepseek', 'deepseek-v3.2', 'DeepSeek V3.2', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('deepseek', 'deepseek-v3', 'DeepSeek V3', { capabilities: textCapabilities(), aliases: ['deepseek-chat'] }),
]

const ZHIPU: readonly BuiltinModelRecord[] = [
  model('zhipu', 'glm-5.3', 'GLM-5.3', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-5.2', 'GLM-5.2', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-5.1', 'GLM-5.1', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-5', 'GLM-5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-4.7', 'GLM-4.7', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-4.6', 'GLM-4.6', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-4.5', 'GLM-4.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-4.5-air', 'GLM-4.5-Air', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('zhipu', 'glm-4.5v', 'GLM-4.5V', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type') }),
  model('zhipu', 'glm-4v-plus', 'GLM-4V-Plus', { capabilities: visionCapabilities() }),
  model('zhipu', 'glm-4-air', 'GLM-4-Air', { capabilities: textCapabilities() }),
  model('zhipu', 'glm-4-flash', 'GLM-4-Flash', { capabilities: textCapabilities() }),
  model('zhipu', 'glm-z1-air', 'GLM-Z1-Air', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking.budget_tokens', 16_384) }),
]

const QWEN: readonly BuiltinModelRecord[] = [
  model('qwen', 'qwen3.8-max', 'Qwen3.8-Max', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3.8-flash', 'Qwen3.8-Flash', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3.8-27b', 'Qwen3.8 27B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3.8-2.4t-a95b', 'Qwen3.8 2.4T-A95B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3.7-max', 'Qwen3.7-Max', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.7-plus', 'Qwen3.7-Plus', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-max', 'Qwen3-Max', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3-max-thinking', 'Qwen3-Max Thinking', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-plus', 'Qwen3-Plus', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3-turbo', 'Qwen3-Turbo', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3.7-flash', 'Qwen3.7-Flash', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen3.6-max-preview', 'Qwen3.6-Max Preview', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.6-plus', 'Qwen3.6-Plus', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.6-flash', 'Qwen3.6-Flash', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.6-35b-a3b', 'Qwen3.6 35B-A3B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.6-27b', 'Qwen3.6 27B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-plus-20260420', 'Qwen3.5-Plus 2026-04-20', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-plus-02-15', 'Qwen3.5-Plus 02-15', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-flash-02-23', 'Qwen3.5-Flash 02-23', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-397b-a17b', 'Qwen3.5 397B-A17B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-122b-a10b', 'Qwen3.5 122B-A10B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-35b-a3b', 'Qwen3.5 35B-A3B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-27b', 'Qwen3.5 27B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3.5-9b', 'Qwen3.5 9B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-coder-next', 'Qwen3 Coder Next', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen3-coder-plus', 'Qwen3 Coder Plus', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen3-coder-flash', 'Qwen3 Coder Flash', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen3-coder-30b-a3b-instruct', 'Qwen3 Coder 30B-A3B Instruct', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen3-coder', 'Qwen3 Coder', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen3-vl-235b-a22b-thinking', 'Qwen3-VL 235B-A22B Thinking', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-vl-235b-a22b-instruct', 'Qwen3-VL 235B-A22B Instruct', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen3-vl-32b-instruct', 'Qwen3-VL 32B Instruct', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen3-vl-30b-a3b-thinking', 'Qwen3-VL 30B-A3B Thinking', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-vl-30b-a3b-instruct', 'Qwen3-VL 30B-A3B Instruct', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen3-vl-8b-thinking', 'Qwen3-VL 8B Thinking', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-vl-8b-instruct', 'Qwen3-VL 8B Instruct', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen3-next-80b-a3b-thinking', 'Qwen3-Next 80B-A3B Thinking', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-next-80b-a3b-instruct', 'Qwen3-Next 80B-A3B Instruct', { capabilities: textCapabilities() }),
  model('qwen', 'qwen3-235b-a22b-thinking-2507', 'Qwen3 235B-A22B Thinking 2507', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-235b-a22b-2507', 'Qwen3 235B-A22B 2507', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-235b-a22b', 'Qwen3 235B-A22B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-30b-a3b-thinking-2507', 'Qwen3 30B-A3B Thinking 2507', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: alwaysThinking() }),
  model('qwen', 'qwen3-30b-a3b-instruct-2507', 'Qwen3 30B-A3B Instruct 2507', { capabilities: textCapabilities() }),
  model('qwen', 'qwen3-30b-a3b', 'Qwen3 30B-A3B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-32b', 'Qwen3 32B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-14b', 'Qwen3 14B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen3-8b', 'Qwen3 8B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen-plus', 'Qwen-Plus', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen-plus-2025-07-28', 'Qwen-Plus 2025-07-28', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('qwen', 'qwen-turbo', 'Qwen-Turbo', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen-max', 'Qwen-Max', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking'), reasoningEfforts: efforts }),
  model('qwen', 'qwen-long', 'Qwen-Long', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen2.5-max', 'Qwen2.5-Max', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen2.5-72b-instruct', 'Qwen2.5 72B Instruct', { capabilities: textCapabilities() }),
  model('qwen', 'qwen2.5-7b-instruct', 'Qwen2.5 7B Instruct', { capabilities: textCapabilities(), aliases: ['qwen-2.5-7b-instruct'] }),
  model('qwen', 'qwen2.5-vl-72b-instruct', 'Qwen2.5 VL 72B Instruct', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B Instruct', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen2-vl-72b-instruct', 'Qwen2 VL 72B Instruct', { capabilities: visionCapabilities() }),
  model('qwen', 'qwq-32b', 'QwQ 32B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('enable_thinking', 32_768) }),
  model('qwen', 'qwen-math-plus', 'Qwen-Math-Plus', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('enable_thinking', 16_384) }),
]

const MOONSHOT: readonly BuiltinModelRecord[] = [
  model('moonshot', 'kimi-k3', 'Kimi K3', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['moonshot/kimi-k3'] }),
  model('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', { capabilities: textCapabilities({ thinking: true, tools: true }), thinkingConfig: toggleThinking('thinking') }),
  model('moonshot', 'kimi-k2.6', 'Kimi K2.6', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('moonshot', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code 高速版', { capabilities: textCapabilities({ thinking: true, tools: true }), thinkingConfig: toggleThinking('thinking') }),
  model('moonshot', 'moonshot-v1-8k', 'Moonshot V1 8K', { capabilities: textCapabilities(), aliases: ['moonshot-v1-8k-vision-preview'] }),
  model('moonshot', 'moonshot-v1-32k', 'Moonshot V1 32K', { capabilities: textCapabilities() }),
  model('moonshot', 'moonshot-v1-128k', 'Moonshot V1 128K', { capabilities: textCapabilities() }),
]

const XAI: readonly BuiltinModelRecord[] = [
  model('xai', 'grok-4.6', 'Grok 4.6', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('xai', 'grok-4.5', 'Grok 4.5', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('xai', 'grok-4.20', 'Grok 4.20', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('xai', 'grok-4', 'Grok 4', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('xai', 'grok-3', 'Grok 3', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('xai', 'grok-3-mini', 'Grok 3 Mini', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('xai', 'grok-2-vision-1212', 'Grok 2 Vision', { capabilities: visionCapabilities() }),
]

const MISTRAL: readonly BuiltinModelRecord[] = [
  model('mistral', 'mistral-large-2512', 'Mistral Large 3', { capabilities: visionCapabilities() }),
  model('mistral', 'mistral-medium-3-5', 'Mistral Medium 3.5', { capabilities: visionCapabilities() }),
  model('mistral', 'mistral-small-3.2', 'Mistral Small 3.2', { capabilities: visionCapabilities() }),
  model('mistral', 'ministral-8b-2512', 'Ministral 8B', { capabilities: textCapabilities() }),
  model('mistral', 'ministral-3b-2512', 'Ministral 3B', { capabilities: textCapabilities() }),
  model('mistral', 'codestral-2508', 'Codestral', { capabilities: textCapabilities({ tools: true }) }),
  model('mistral', 'devstral-2512', 'Devstral', { capabilities: textCapabilities({ tools: true }) }),
  model('mistral', 'magistral-medium-2509', 'Magistral Medium', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('mistral', 'magistral-small-2509', 'Magistral Small', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('mistral', 'pixtral-large-2411', 'Pixtral Large', { capabilities: visionCapabilities() }),
  model('mistral', 'pixtral-12b-2409', 'Pixtral 12B', { capabilities: visionCapabilities() }),
]

const COHERE: readonly BuiltinModelRecord[] = [
  model('cohere', 'command-a-plus-05-2026', 'Command A+', { capabilities: textCapabilities({ tools: true, webSearch: true }) }),
  model('cohere', 'command-a-03-2025', 'Command A', { capabilities: textCapabilities({ tools: true, webSearch: true }) }),
  model('cohere', 'command-r-plus', 'Command R+', { capabilities: textCapabilities({ tools: true }) }),
  model('cohere', 'command-r', 'Command R', { capabilities: textCapabilities({ tools: true }) }),
  model('cohere', 'command-light', 'Command Light', { capabilities: textCapabilities() }),
]

const MINIMAX: readonly BuiltinModelRecord[] = [
  model('minimax', 'MiniMax-M3', 'MiniMax M3', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['minimax-m3', 'MiniMax-M3.1'] }),
  model('minimax', 'MiniMax-M2.7', 'MiniMax M2.7', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['minimax-m2.7'] }),
  model('minimax', 'MiniMax-M2.5', 'MiniMax M2.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['minimax-m2.5'] }),
  model('minimax', 'MiniMax-M2.1', 'MiniMax M2.1', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['minimax-m2.1'] }),
  model('minimax', 'MiniMax-M2', 'MiniMax M2', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['minimax-m2'] }),
  model('minimax', 'MiniMax-M2-her', 'MiniMax M2 her', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking'), aliases: ['minimax-m2-her'] }),
  model('minimax', 'MiniMax-M1', 'MiniMax M1', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('reasoning_split', 32_768), aliases: ['minimax-m1'] }),
  model('minimax', 'abab6.5s-chat', 'abab 6.5s', { capabilities: visionCapabilities(), aliases: ['abab6.5s'] }),
  model('minimax', 'abab6.5-chat', 'abab 6.5', { capabilities: textCapabilities() }),
  model('minimax', 'MiniMax-VL-01', 'MiniMax VL 01', { capabilities: visionCapabilities() }),
  model('minimax', 'MiniMax-Text-01', 'MiniMax Text 01', { capabilities: textCapabilities() }),
  model('minimax', 'MiniMax-01', 'MiniMax 01', { capabilities: textCapabilities() }),
]

const HUNYUAN: readonly BuiltinModelRecord[] = [
  model('hunyuan', 'hunyuan-turbo', '混元 Turbo', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('hunyuan', 'hunyuan-pro', '混元 Pro', { capabilities: textCapabilities() }),
  model('hunyuan', 'hunyuan-large', '混元 Large', { capabilities: textCapabilities() }),
  model('hunyuan', 'hunyuan-a13b', '混元 A13B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768) }),
  model('hunyuan', 'hunyuan-a13b-instruct', '混元 A13B Instruct', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768) }),
  model('hunyuan', 'hunyuan-t1', '混元 T1', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768) }),
  model('hunyuan', 'hy4-preview', 'HY 4 Preview', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768), aliases: ['hunyuan-4-preview'] }),
  model('hunyuan', 'hy3', 'HY 3', { capabilities: textCapabilities(), aliases: ['hy3-preview', 'hunyuan-3'] }),
  model('hunyuan', 'hy-mt2-30b-a3b', 'HY-MT2 30B-A3B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 16_384) }),
  model('hunyuan', 'hy-mt2-7b', 'HY-MT2 7B', { capabilities: textCapabilities() }),
  model('hunyuan', 'hy-mt2-1.8b', 'HY-MT2 1.8B', { capabilities: textCapabilities() }),
  model('hunyuan', 'hunyuan-vision', '混元 Vision', { capabilities: visionCapabilities() }),
  model('hunyuan', 'hunyuan-muse', '混元 Muse', { modality: 'image', capabilities: imageCapabilities(), aliases: ['hy-muse', 'HY-Muse'] }),
  model('hunyuan', 'hunyuan-muse-vision', '混元 Muse Vision', { capabilities: visionCapabilities(), aliases: ['hy-muse-vision'] }),
  model('hunyuan', 'hunyuan-image', '混元生图', { modality: 'image', capabilities: imageCapabilities() }),
  model('hunyuan', 'hunyuan-video', '混元视频', { modality: 'video', capabilities: videoCapabilities(), aliases: ['hunyuan-video-3.0'] }),
]

const XIAOMI: readonly BuiltinModelRecord[] = [
  model('xiaomi', 'mimo-v2.5-pro', 'MiMo V2.5 Pro', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts, aliases: ['xiaomi/mimo-v2.5-pro'] }),
  model('xiaomi', 'mimo-v2.5', 'MiMo V2.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts, aliases: ['xiaomi/mimo-v2.5'] }),
  model('xiaomi', 'mimo-v2-flash', 'MiMo V2 Flash', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('xiaomi', 'mimo-vl-7b', 'MiMo-VL 7B', { capabilities: visionCapabilities() }),
  model('xiaomi', 'mimo-audio', 'MiMo Audio', { capabilities: audioCapabilities({ audioInput: true }) }),
]

/** Muse models are published as a separate family by several gateways. */
const MUSE: readonly BuiltinModelRecord[] = [
  model('muse', 'muse-spark-1.3', 'Muse Spark 1.3', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts, aliases: ['muse-spark-1.3-contributor'] }),
  model('muse', 'muse-spark-1.2', 'Muse Spark 1.2', { capabilities: visionCapabilities() }),
  model('muse', 'muse-spark-1.1', 'Muse Spark 1.1', { capabilities: visionCapabilities() }),
  model('muse', 'muse-glimmer-30b', 'Muse Glimmer 30B', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
]

const DOUBAO: readonly BuiltinModelRecord[] = [
  model('doubao', 'doubao-seed-1-6', '豆包 Seed 1.6', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking.type'), reasoningEfforts: efforts }),
  model('doubao', 'doubao-seed-1-6-thinking', '豆包 Seed 1.6 Thinking', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768) }),
  model('doubao', 'doubao-1-5-pro-32k', '豆包 1.5 Pro 32K', { capabilities: visionCapabilities() }),
  model('doubao', 'doubao-1-5-lite-32k', '豆包 1.5 Lite 32K', { capabilities: textCapabilities() }),
  model('doubao', 'doubao-seedream-4-0', 'Seedream 4.0', { modality: 'image', capabilities: imageCapabilities(), aliases: ['seedream-4.0'] }),
  model('doubao', 'doubao-seedance-1-0-pro', 'Seedance 1.0 Pro', { modality: 'video', capabilities: videoCapabilities(), aliases: ['seedance-1.0-pro'] }),
]

const BAIDU: readonly BuiltinModelRecord[] = [
  model('baidu', 'ernie-5.0', 'ERNIE 5.0', { capabilities: visionCapabilities({ thinking: true, webSearch: true }), thinkingConfig: toggleThinking('enable_thinking') }),
  model('baidu', 'ernie-4.5-turbo', 'ERNIE 4.5 Turbo', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('baidu', 'ernie-4.0-turbo', 'ERNIE 4.0 Turbo', { capabilities: visionCapabilities({ webSearch: true }) }),
  model('baidu', 'ernie-speed-128k', 'ERNIE Speed 128K', { capabilities: textCapabilities() }),
  model('baidu', 'ernie-lite-8k', 'ERNIE Lite 8K', { capabilities: textCapabilities() }),
  model('baidu', 'ernie-x1-turbo', 'ERNIE X1 Turbo', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768) }),
  model('baidu', 'ernie-vl-1.0', 'ERNIE-VL 1.0', { capabilities: visionCapabilities() }),
  model('baidu', 'ernie-image', 'ERNIE Image', { modality: 'image', capabilities: imageCapabilities() }),
]

const STEPFUN: readonly BuiltinModelRecord[] = [
  model('stepfun', 'step-3', 'Step-3', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('stepfun', 'step-2-16k', 'Step-2 16K', { capabilities: textCapabilities() }),
  model('stepfun', 'step-1v-8k', 'Step-1V 8K', { capabilities: visionCapabilities() }),
  model('stepfun', 'step-1o-vision-32k', 'Step-1o Vision 32K', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('stepfun', 'step-1-flash', 'Step-1 Flash', { capabilities: textCapabilities() }),
]

const BAICHUAN: readonly BuiltinModelRecord[] = [
  model('baichuan', 'Baichuan4', 'Baichuan 4', { capabilities: visionCapabilities() }),
  model('baichuan', 'Baichuan3-Turbo', 'Baichuan 3 Turbo', { capabilities: textCapabilities() }),
  model('baichuan', 'Baichuan2-Turbo', 'Baichuan 2 Turbo', { capabilities: textCapabilities() }),
  model('baichuan', 'Baichuan-Omni-1.5', 'Baichuan Omni 1.5', { capabilities: visionCapabilities({ audioInput: true }) }),
  model('baichuan', 'Baichuan-M2', 'Baichuan M2', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 16_384) }),
]

const SENSENOVA: readonly BuiltinModelRecord[] = [
  model('sensenova', 'SenseNova-V6-5', 'SenseNova V6.5', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('sensenova', 'SenseNova-V6', 'SenseNova V6', { capabilities: visionCapabilities() }),
  model('sensenova', 'SenseNova-5', 'SenseNova 5', { capabilities: textCapabilities() }),
  model('sensenova', 'SenseNova-Omni', 'SenseNova Omni', { capabilities: visionCapabilities({ audioInput: true }) }),
]

const SPARK: readonly BuiltinModelRecord[] = [
  model('spark', 'spark-4.0-ultra', '讯飞星火 4.0 Ultra', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('spark', 'spark-x1', '讯飞星火 X1', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: budgetThinking('thinking_budget', 32_768) }),
  model('spark', 'generalv3.5', '讯飞星火 V3.5', { capabilities: textCapabilities() }),
  model('spark', 'spark-lite', '讯飞星火 Lite', { capabilities: textCapabilities() }),
]

const YI: readonly BuiltinModelRecord[] = [
  model('yi', 'yi-large', 'Yi Large', { capabilities: textCapabilities({ thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('yi', 'yi-large-turbo', 'Yi Large Turbo', { capabilities: textCapabilities() }),
  model('yi', 'yi-lightning', 'Yi Lightning', { capabilities: textCapabilities() }),
  model('yi', 'yi-vision', 'Yi Vision', { capabilities: visionCapabilities() }),
  model('yi', 'yi-1.5-34b-chat', 'Yi 1.5 34B Chat', { capabilities: textCapabilities() }),
]

const META: readonly BuiltinModelRecord[] = [
  model('meta', 'meta-llama/llama-4-maverick', 'Llama 4 Maverick', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('meta', 'meta-llama/llama-4-scout', 'Llama 4 Scout', { capabilities: visionCapabilities({ thinking: true }), thinkingConfig: toggleThinking('thinking') }),
  model('meta', 'meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct', { capabilities: textCapabilities() }),
  model('meta', 'meta-llama/llama-3.2-90b-vision-instruct', 'Llama 3.2 90B Vision', { capabilities: visionCapabilities() }),
  model('meta', 'meta-llama/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', { capabilities: visionCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-405b-instruct', 'Llama 3.1 405B Instruct', { capabilities: textCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct', { capabilities: textCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct', { capabilities: textCapabilities() }),
]

const MICROSOFT: readonly BuiltinModelRecord[] = [
  model('microsoft', 'phi-4', 'Phi-4', { capabilities: textCapabilities() }),
  model('microsoft', 'phi-4-mini-instruct', 'Phi-4 Mini Instruct', { capabilities: textCapabilities() }),
  model('microsoft', 'phi-4-multimodal-instruct', 'Phi-4 Multimodal Instruct', { capabilities: visionCapabilities({ audioInput: true }) }),
]

const AMAZON: readonly BuiltinModelRecord[] = [
  model('amazon', 'amazon.nova-pro-v1:0', 'Amazon Nova Pro', { capabilities: visionCapabilities() }),
  model('amazon', 'amazon.nova-lite-v1:0', 'Amazon Nova Lite', { capabilities: visionCapabilities() }),
  model('amazon', 'amazon.nova-micro-v1:0', 'Amazon Nova Micro', { capabilities: textCapabilities() }),
  model('amazon', 'amazon.nova-canvas-v1:0', 'Amazon Nova Canvas', { modality: 'image', capabilities: imageCapabilities() }),
  model('amazon', 'amazon.nova-reel-v1:0', 'Amazon Nova Reel', { modality: 'video', capabilities: videoCapabilities() }),
]

const AUDIO_MODELS: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-4o-audio-preview', 'GPT-4o Audio Preview', { capabilities: audioCapabilities({ audioInput: true, textInput: true, textOutput: true }) }),
  model('openai', 'gpt-4o-mini-audio-preview', 'GPT-4o mini Audio Preview', { capabilities: audioCapabilities({ audioInput: true, textInput: true, textOutput: true }) }),
  model('google', 'gemini-2.5-flash-native-audio', 'Gemini 2.5 Flash Native Audio', { capabilities: audioCapabilities({ audioInput: true, textInput: true, textOutput: true, vision: true }) }),
]

const AI21: readonly BuiltinModelRecord[] = [
  model('ai21', 'jamba-1.6-large', 'Jamba 1.6 Large', { capabilities: textCapabilities() }),
  model('ai21', 'jamba-1.6-mini', 'Jamba 1.6 Mini', { capabilities: textCapabilities() }),
  model('ai21', 'jamba-1.5-large', 'Jamba 1.5 Large', { capabilities: textCapabilities() }),
  model('ai21', 'jamba-1.5-mini', 'Jamba 1.5 Mini', { capabilities: textCapabilities() }),
]

const PERPLEXITY: readonly BuiltinModelRecord[] = [
  model('perplexity', 'sonar', 'Sonar', { capabilities: textCapabilities({ webSearch: true }) }),
  model('perplexity', 'sonar-pro', 'Sonar Pro', { capabilities: textCapabilities({ webSearch: true }) }),
  model('perplexity', 'sonar-reasoning', 'Sonar Reasoning', { capabilities: textCapabilities({ webSearch: true, thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('perplexity', 'sonar-reasoning-pro', 'Sonar Reasoning Pro', { capabilities: textCapabilities({ webSearch: true, thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
  model('perplexity', 'sonar-deep-research', 'Sonar Deep Research', { capabilities: textCapabilities({ webSearch: true, thinking: true }), thinkingConfig: effortThinking('reasoning_effort'), reasoningEfforts: efforts }),
]

const INTERNLM: readonly BuiltinModelRecord[] = [
  model('internlm', 'internlm3.5-20b-instruct', 'InternLM 3.5 20B', { capabilities: textCapabilities() }),
  model('internlm', 'internvl3-78b', 'InternVL 3 78B', { capabilities: visionCapabilities() }),
  model('internlm', 'internvl3-38b', 'InternVL 3 38B', { capabilities: visionCapabilities() }),
]

/**
 * The complete built-in catalogue.  Keep this list independent from
 * `PROVIDER_PRESETS`: adding a connection must never be required for a model
 * to appear here.  User-created records are merged by the catalog service.
 */
export const BUILTIN_MODEL_CATALOG: readonly BuiltinModelRecord[] = [
  ...OPENAI,
  ...ANTHROPIC,
  ...GOOGLE,
  ...DEEPSEEK,
  ...ZHIPU,
  ...QWEN,
  ...MOONSHOT,
  ...XAI,
  ...MISTRAL,
  ...COHERE,
  ...MINIMAX,
  ...HUNYUAN,
  ...XIAOMI,
  ...MUSE,
  ...DOUBAO,
  ...BAIDU,
  ...STEPFUN,
  ...BAICHUAN,
  ...SENSENOVA,
  ...SPARK,
  ...YI,
  ...META,
  ...MICROSOFT,
  ...AMAZON,
  ...AUDIO_MODELS,
  ...AI21,
  ...PERPLEXITY,
  ...INTERNLM,
]

/** Case-insensitive lookup, including aliases and aggregator-prefixed IDs. */
export function findBuiltinModel(modelId: string): BuiltinModelRecord | undefined {
  const wanted = modelId.trim().toLowerCase()
  return BUILTIN_MODEL_CATALOG.find((entry) => {
    const ids = [entry.id, ...(entry.aliases ?? [])]
    return ids.some((id) => {
      const candidate = id.toLowerCase()
      return wanted === candidate || wanted.endsWith(`/${candidate}`)
    })
  })
}
