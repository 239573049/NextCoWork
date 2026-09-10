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
import type { ModelCapabilities, ModelModality, RequestAdapterConfig, ThinkingConfig } from './provider'
import type { ModelCatalogDefinition, ModelCatalogVerificationStatus } from './model-catalog'

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

export const MODEL_CATALOG_FETCHED_AT = '2026-09-05'

/**
 * Vendor families shown in the model-management sidebar.  Do not add a
 * configured-provider entry here: this list is about model manufacturers.
 */
export const MODEL_MANUFACTURERS: readonly ModelManufacturer[] = [
  { id: 'openai', label: 'OpenAI', aliases: ['openai', 'gpt', 'chatgpt'] },
  { id: 'anthropic', label: 'Anthropic', aliases: ['anthropic', 'claude'] },
  {
    id: 'google',
    label: 'Google',
    aliases: ['google', 'gemini', 'gemma', 'vertex'],
  },
  { id: 'deepseek', label: 'DeepSeek', aliases: ['deepseek', 'deep-seek'] },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    aliases: ['zhipu', 'z.ai', 'glm', 'chatglm'],
  },
  {
    id: 'qwen',
    label: '阿里云 Qwen',
    aliases: ['qwen', 'qwq', 'tongyi', '通义', 'dashscope'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    aliases: ['moonshot', 'kimi', '月之暗面'],
  },
  { id: 'xai', label: 'xAI Grok', aliases: ['xai', 'grok'] },
  {
    id: 'mistral',
    label: 'Mistral AI',
    aliases: ['mistral', 'mixtral', 'codestral', 'devstral', 'pixtral'],
  },
  { id: 'cohere', label: 'Cohere', aliases: ['cohere', 'command'] },
  { id: 'minimax', label: 'MiniMax', aliases: ['minimax', 'abab'] },
  {
    id: 'hunyuan',
    label: '腾讯混元 / Hunyuan',
    aliases: ['hunyuan', '腾讯混元', 'hy-muse'],
  },
  { id: 'xiaomi', label: '小米 MiMo', aliases: ['xiaomi', 'mimo', '小米'] },
  {
    id: 'meituan',
    label: '美团 LongCat',
    aliases: ['meituan', 'longcat', '美团'],
  },
  {
    id: 'doubao',
    label: '字节跳动豆包 / Doubao',
    aliases: ['doubao', 'seed', 'seedream', 'seedance'],
  },
  {
    id: 'baidu',
    label: '百度文心 / ERNIE',
    aliases: ['baidu', 'ernie', 'wenxin', '文心'],
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    aliases: ['stepfun', 'step-', '阶跃'],
  },
  { id: 'baichuan', label: '百川智能', aliases: ['baichuan', '百川'] },
  {
    id: 'sensenova',
    label: '商汤 SenseNova',
    aliases: ['sensenova', 'sensechat', '商汤', '日日新'],
  },
  {
    id: 'spark',
    label: '讯飞星火',
    aliases: ['spark', 'xfyun', '讯飞', '星火'],
  },
  {
    id: 'pangu',
    label: '华为盘古 / openPangu',
    aliases: ['pangu', 'openpangu', '华为盘古'],
  },
  { id: 'yi', label: '零一万物 Yi', aliases: ['yi-', '01.ai', '零一万物'] },
  { id: 'meta', label: 'Meta', aliases: ['meta', 'llama', 'muse'] },
  { id: 'microsoft', label: 'Microsoft Phi', aliases: ['microsoft', 'phi'] },
  {
    id: 'amazon',
    label: 'Amazon Nova',
    aliases: ['amazon', 'nova', 'bedrock'],
  },
  { id: 'ai21', label: 'AI21 Labs Jamba', aliases: ['ai21', 'jamba'] },
  { id: 'perplexity', label: 'Perplexity', aliases: ['perplexity', 'sonar'] },
  {
    id: 'internlm',
    label: '上海人工智能实验室 InternLM',
    aliases: ['internlm', 'internvl'],
  },
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
  openai: source('https://developers.openai.com/api/docs/models'),
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
  hunyuan: source('https://cloud.tencent.com/document/product/1823/130051'),
  xiaomi: source('https://platform.xiaomimimo.com/'),
  doubao: source('https://docs.volcengine.com/docs/82379/1330310'),
  baidu: source('https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j'),
  stepfun: source('https://platform.stepfun.com/docs/overview'),
  baichuan: source('https://platform.baichuan-ai.com/docs/api'),
  sensenova: source('https://console.sensecore.cn/help/docs/model-as-a-service/nova'),
  spark: source('https://www.xfyun.cn/doc/spark/Web.html'),
  pangu: source('https://support.huaweicloud.com/model-list-maas/model_list_0001.html'),
  yi: source('https://platform.lingyiwanwu.com/docs'),
  meta: source('https://www.llama.com/docs/model-cards-and-prompt-formats/'),
  microsoft: source('https://learn.microsoft.com/azure/ai-studio/how-to/deploy-models-phi-3'),
  amazon: source('https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html'),
  ai21: source('https://docs.ai21.com/docs/jamba-models'),
  perplexity: source('https://docs.perplexity.ai/getting-started/models'),
  internlm: source('https://internlm.intern-ai.org.cn/doc/docs/%E6%A8%A1%E5%9E%8B%E5%88%97%E8%A1%A8/'),
} as const

const OPENCODE_GO_SOURCE = source('https://opencode.ai/docs/go/')

const efforts = ['minimal', 'low', 'medium', 'high', 'max'] as const
const openAiModernEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const openAiAstraEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const textCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  // `tools` is the one flag where the conservative default below is wrong,
  // because for this one the asymmetry runs the other way. AgentSession throws
  // away the whole tool schema when a model reports tools: false (see
  // `modelSupportsTools` in model-runtime.ts), so a false negative silently
  // demotes the agent to a chat box: no error, no log, just a model that
  // answers "give me the file path" instead of reading the file. A false
  // positive sends a `tools` array the upstream either ignores or rejects with
  // a 400 you can actually read.
  //
  // Defaulting to false also made the column rot: it was filled in for ~25% of
  // rows at random, so ernie-5.0 had tools while ernie-5.1 did not, and no
  // Claude or GPT row had them at all. Defaulting to true means a newly added
  // row is right unless the vendor is unusual, instead of wrong until someone
  // notices the agent went quiet.
  //
  // Every row that overrides this back to false was checked against that
  // vendor's own docs on 2026-09-08; the evidence table is in
  // __tests__/model-catalog-tools.test.ts, which also pins the list.
  tools: true,
  // The remaining defaults stay conservative. For them a false negative only
  // hides an optional control until the row is verified, while a false
  // positive can make the runtime send an unsupported field and fail the
  // whole request.
  vision: false,
  visionInput: false,
  thinking: false,
  caching: false,
  textInput: true,
  fileInput: false,
  videoInput: false,
  audioInput: false,
  textOutput: true,
  imageOutput: false,
  videoOutput: false,
  audioOutput: false,
  webSearch: false,
  structuredOutput: false,
  streaming: false,
  batch: false,
  ...overrides,
})

const visionCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  // Image content parts and uploaded/document files are separate upstream
  // capabilities. Never infer File support merely because Vision is present.
  textCapabilities({ vision: true, visionInput: true, ...overrides })

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

const unsupportedThinking: ThinkingConfig = {
  mode: 'unsupported',
  defaultEnabled: false,
}
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
  source?: BuiltinModelRecord['source']
  aliases?: readonly string[]
  pricingModelId?: string
  verificationStatus?: ModelCatalogVerificationStatus
}

function manufacturer(id: string): ModelManufacturer {
  return MANUFACTURER_BY_ID.get(id) ?? MANUFACTURER_BY_ID.get('other')!
}

function model(manufacturerId: string, id: string, displayName: string, options: ModelOptions = {}): BuiltinModelRecord {
  const m = manufacturer(manufacturerId)
  const capabilities = options.capabilities ?? textCapabilities()
  const thinkingConfig = options.thinkingConfig ?? (capabilities.thinking ? toggleThinking() : unsupportedThinking)
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
    source: options.source ?? SOURCES[m.id as keyof typeof SOURCES],
    verificationStatus: options.verificationStatus ?? 'unverified',
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    pricingModelId: options.pricingModelId ?? id,
  }
}

const OPENAI: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-6-astra', 'GPT-6 Astra', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiAstraEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiModernEfforts,
    aliases: ['gpt-5.6'],
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiModernEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', {
    capabilities: visionCapabilities({
      thinking: true,
      webSearch: true,
      batch: true,
    }),
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiModernEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.6-cyber', 'GPT-5.6 Cyber', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: openAiAstraEfforts,
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-5.5', 'GPT-5.5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4', 'GPT-5.4', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4-nano', 'GPT-5.4 nano', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.4-pro', 'GPT-5.4 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.2', 'GPT-5.2', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.2-pro', 'GPT-5.2 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.3-chat-latest', 'GPT-5.3 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-5.2-codex', 'GPT-5.2 Codex', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.2-chat-latest', 'GPT-5.2 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-5.1', 'GPT-5.1', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-codex', 'GPT-5.1 Codex', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-codex-max', 'GPT-5.1 Codex Max', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5.1-chat-latest', 'GPT-5.1 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-5', 'GPT-5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-mini', 'GPT-5 mini', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-nano', 'GPT-5 nano', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-pro', 'GPT-5 Pro', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-codex', 'GPT-5 Codex', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-5-chat-latest', 'GPT-5 Chat', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4.1', 'GPT-4.1', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4.1-nano', 'GPT-4.1 nano', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4o', 'GPT-4o', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'gpt-4o-mini', 'GPT-4o mini', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('openai', 'o1', 'o1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o1-pro', 'o1 Pro', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3', 'o3', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3-pro', 'o3 Pro', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3-mini', 'o3 mini', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o3-deep-research', 'o3 Deep Research', {
    capabilities: visionCapabilities({ tools: false, thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o4-mini', 'o4 mini', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o4-mini-deep-research', 'o4 Mini Deep Research', {
    capabilities: visionCapabilities({ tools: false, thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o1-mini', 'o1 Mini', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'o1-preview', 'o1 Preview', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-4-turbo', 'GPT-4 Turbo', {
    capabilities: visionCapabilities(),
  }),
  model('openai', 'gpt-4-turbo-2024-04-09', 'GPT-4 Turbo 2024-04-09', {
    capabilities: visionCapabilities(),
  }),
  model('openai', 'gpt-4', 'GPT-4'),
  model('openai', 'gpt-4-0613', 'GPT-4 0613'),
  model('openai', 'gpt-3.5-turbo', 'GPT-3.5 Turbo'),
  model('openai', 'gpt-oss-120b', 'GPT OSS 120B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium', 'high'],
  }),
  model('openai', 'gpt-oss-20b', 'GPT OSS 20B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium', 'high'],
  }),
  model('openai', 'codex-mini-latest', 'Codex Mini', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'computer-use-preview', 'Computer Use Preview', {
    capabilities: visionCapabilities({ tools: true }),
  }),
  model('openai', 'gpt-4o-search-preview', 'GPT-4o Search Preview', {
    capabilities: visionCapabilities({ tools: false, webSearch: true }),
  }),
  model('openai', 'gpt-4o-mini-search-preview', 'GPT-4o Mini Search Preview', {
    capabilities: visionCapabilities({ tools: false, webSearch: true }),
  }),
]

const OPENAI_MEDIA: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-image-2', 'GPT Image 2', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-image-1.5', 'GPT Image 1.5', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-image-1', 'GPT Image 1', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'gpt-image-1-mini', 'GPT Image 1 Mini', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'chatgpt-image-latest', 'ChatGPT Image', {
    modality: 'image',
    capabilities: imageCapabilities({
      vision: true,
      visionInput: true,
      fileInput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'sora-2', 'Sora 2', {
    modality: 'video',
    capabilities: videoCapabilities({
      vision: true,
      visionInput: true,
      audioOutput: true,
    }),
    verificationStatus: 'official-api',
  }),
  model('openai', 'sora-2-pro', 'Sora 2 Pro', {
    modality: 'video',
    capabilities: videoCapabilities({
      vision: true,
      visionInput: true,
      audioOutput: true,
    }),
    verificationStatus: 'official-api',
  }),
]

const ANTHROPIC: readonly BuiltinModelRecord[] = [
  model('anthropic', 'claude-opus-5', 'Claude Opus 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-mythos-5-1', 'Claude Mythos 5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-mythos-5', 'Claude Mythos 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-fable-5', 'Claude Fable 5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 64_000),
  }),
  model('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_000),
  }),
  model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000),
  }),
  model('anthropic', 'claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_000),
    aliases: ['claude-3-7-sonnet-20250219'],
  }),
  model('anthropic', 'claude-3-5-sonnet-latest', 'Claude 3.5 Sonnet', {
    capabilities: visionCapabilities(),
    aliases: ['claude-3-5-sonnet-20241022'],
  }),
  model('anthropic', 'claude-3-5-haiku-latest', 'Claude 3.5 Haiku', {
    capabilities: visionCapabilities(),
    aliases: ['claude-3-5-haiku-20241022'],
  }),
]

const geminiStandardCapabilities = (fileInput = true): ModelCapabilities =>
  visionCapabilities({
    thinking: true,
    fileInput,
    videoInput: true,
    audioInput: true,
    tools: true,
    caching: true,
    webSearch: true,
    structuredOutput: true,
    streaming: true,
    batch: true,
  })

const GOOGLE: readonly BuiltinModelRecord[] = [
  model('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'medium'),
    reasoningEfforts: ['low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'medium'),
    reasoningEfforts: ['low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'medium'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'medium'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'minimal'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['low', 'medium', 'high'],
    aliases: ['gemini-3.1-pro'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'minimal'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'medium'),
    reasoningEfforts: ['low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: effortThinking('reasoning_effort', 'medium'),
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', {
    capabilities: geminiStandardCapabilities(),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: {
      mode: 'effort',
      defaultEnabled: false,
      defaultEffort: 'medium',
      parameterPath: 'reasoning_effort',
    },
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite'),
    verificationStatus: 'official-api',
  }),
  model('google', 'gemma-3-27b-it', 'Gemma 3 27B', {
    capabilities: visionCapabilities({ tools: false }),
    source: source('https://ai.google.dev/gemma/docs/core/model_card_3'),
    verificationStatus: 'official-model-card',
  }),
  model('google', 'gemma-3-12b-it', 'Gemma 3 12B', {
    capabilities: visionCapabilities({ tools: false }),
    source: source('https://ai.google.dev/gemma/docs/core/model_card_3'),
    verificationStatus: 'official-model-card',
  }),
  model('google', 'gemma-3-4b-it', 'Gemma 3 4B', {
    capabilities: visionCapabilities({ tools: false }),
    source: source('https://ai.google.dev/gemma/docs/core/model_card_3'),
    verificationStatus: 'official-model-card',
  }),
]

const DEEPSEEK: readonly BuiltinModelRecord[] = [
  // DeepSeek announced this as a time-limited preview on 2026-09-08. Its
  // public announcement confirms native multimodal input and says billing
  // follows V4 Flash, but does not publish independent limits. Keep the
  // compatible V4 Flash limits below until an official model card exists.
  model('deepseek', 'deepseek-v4.1-flash-expires-on-0910', 'DeepSeek V4.1 Flash', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['none', 'low', 'high', 'max'],
    aliases: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-beta'],
    pricingModelId: 'deepseek-v4-flash',
    source: source('https://api-docs.deepseek.com/'),
    verificationStatus: 'unverified',
  }),
  model('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['none', 'low', 'high', 'max'],
    aliases: ['DeepSeek-V4-Pro-0813'],
    source: source('https://api-docs.deepseek.com/quick_start/pricing/'),
    verificationStatus: 'official-api',
  }),
  model('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['none', 'low', 'high', 'max'],
    aliases: ['DeepSeek-V4-Flash-0731'],
    source: source('https://api-docs.deepseek.com/quick_start/pricing/'),
    verificationStatus: 'official-api',
  }),
  model('deepseek', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (实验)', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['none', 'low', 'high', 'max'],
    source: source('https://api-docs.deepseek.com/quick_start/pricing/'),
    verificationStatus: 'official-api',
  }),
  model('deepseek', 'deepseek-r1', 'DeepSeek R1', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 32_768),
    aliases: ['deepseek-reasoner'],
  }),
  model('deepseek', 'deepseek-v3.2', 'DeepSeek V3.2', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('deepseek', 'deepseek-v3', 'DeepSeek V3', {
    capabilities: textCapabilities(),
    aliases: ['deepseek-chat'],
  }),
]

const ZHIPU: readonly BuiltinModelRecord[] = [
  model('zhipu', 'glm-5.3', 'GLM-5.3', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-5.3-flash', 'GLM-5.3-Flash', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning_effort', 'max'),
    reasoningEfforts: ['low', 'high', 'max'],
    source: source('https://docs.z.ai/guides/vlm/glm-5.3-flash'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-5.2', 'GLM-5.2', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-5.1', 'GLM-5.1', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-5', 'GLM-5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-4.7', 'GLM-4.7', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-4.7-flashx', 'GLM-4.7-FlashX', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    thinkingConfig: toggleThinking('thinking.type'),
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-4.6', 'GLM-4.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-4.5', 'GLM-4.5', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-4.5-x', 'GLM-4.5-X', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    thinkingConfig: toggleThinking('thinking.type'),
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-4.5-air', 'GLM-4.5-Air', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
    reasoningEfforts: efforts,
  }),
  model('zhipu', 'glm-4.5-airx', 'GLM-4.5-AirX', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    thinkingConfig: toggleThinking('thinking.type'),
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-4-32b-0414-128k', 'GLM-4 32B 0414 128K', {
    capabilities: textCapabilities({
      tools: true,
      structuredOutput: true,
      streaming: true,
    }),
    contextWindow: 128_000,
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-4.6v', 'GLM-4.6V', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    thinkingConfig: toggleThinking('thinking.type'),
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-ocr', 'GLM-OCR', {
    capabilities: visionCapabilities({
      tools: false,
      fileInput: true,
      structuredOutput: true,
      streaming: true,
    }),
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-4.6v-flashx', 'GLM-4.6V-FlashX', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
      streaming: true,
    }),
    thinkingConfig: toggleThinking('thinking.type'),
    source: source('https://docs.z.ai/guides/overview/pricing.md'),
    verificationStatus: 'official-api',
  }),
  model('zhipu', 'glm-4.5v', 'GLM-4.5V', {
    capabilities: visionCapabilities({ tools: false, thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
  }),
  model('zhipu', 'glm-4v-plus', 'GLM-4V-Plus', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('zhipu', 'glm-4-air', 'GLM-4-Air', {
    capabilities: textCapabilities(),
  }),
  model('zhipu', 'glm-4-flash', 'GLM-4-Flash', {
    capabilities: textCapabilities(),
  }),
  model('zhipu', 'glm-z1-air', 'GLM-Z1-Air', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking.budget_tokens', 16_384),
  }),
]

const QWEN: readonly BuiltinModelRecord[] = [
  model('qwen', 'qwen3.8-max', 'Qwen3.8-Max', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('qwen', 'qwen3.8-flash', 'Qwen3.8-Flash', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('qwen', 'qwen3.8-27b', 'Qwen3.8 27B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('qwen', 'qwen3.8-2.4t-a95b', 'Qwen3.8 2.4T-A95B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('qwen', 'qwen3.7-max', 'Qwen3.7-Max', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.7-plus', 'Qwen3.7-Plus', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-max', 'Qwen3-Max', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-max-thinking', 'Qwen3-Max Thinking', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
    pricingModelId: 'qwen3-max',
  }),
  model('qwen', 'qwen3-plus', 'Qwen3-Plus', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-turbo', 'Qwen3-Turbo', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.7-flash', 'Qwen3.7-Flash', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.6-max-preview', 'Qwen3.6-Max Preview', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.6-plus', 'Qwen3.6-Plus', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.6-flash', 'Qwen3.6-Flash', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.6-35b-a3b', 'Qwen3.6 35B-A3B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.6-27b', 'Qwen3.6 27B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.5-plus', 'Qwen3.5 Plus', {
    capabilities: visionCapabilities({
      thinking: true,
      videoInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    thinkingConfig: toggleThinking('enable_thinking'),
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('qwen', 'qwen3.5-plus-2026-04-20', 'Qwen3.5-Plus 2026-04-20', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
    pricingModelId: 'qwen3.5-plus',
    aliases: ['qwen3.5-plus-20260420'],
  }),
  model('qwen', 'qwen3.5-plus-2026-02-15', 'Qwen3.5-Plus 2026-02-15', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
    pricingModelId: 'qwen3.5-plus',
    aliases: ['qwen3.5-plus-02-15'],
  }),
  model('qwen', 'qwen3.5-flash', 'Qwen3.5-Flash', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.5-flash-2026-02-23', 'Qwen3.5-Flash 2026-02-23', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
    pricingModelId: 'qwen3.5-flash',
    aliases: ['qwen3.5-flash-02-23'],
  }),
  model('qwen', 'qwen3.5-397b-a17b', 'Qwen3.5 397B-A17B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.5-122b-a10b', 'Qwen3.5 122B-A10B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.5-35b-a3b', 'Qwen3.5 35B-A3B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.5-27b', 'Qwen3.5 27B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3.5-9b', 'Qwen3.5 9B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-coder-next', 'Qwen3 Coder Next', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
    verificationStatus: 'official-api',
  }),
  model('qwen', 'qwen3-coder-plus', 'Qwen3 Coder Plus', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
    verificationStatus: 'official-api',
  }),
  model('qwen', 'qwen3-coder-flash', 'Qwen3 Coder Flash', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
    verificationStatus: 'official-api',
  }),
  model('qwen', 'qwen3-coder-30b-a3b-instruct', 'Qwen3 Coder 30B-A3B Instruct', { capabilities: textCapabilities({ tools: true }) }),
  model('qwen', 'qwen3-coder', 'Qwen3 Coder', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('qwen', 'qwen3-vl-235b-a22b-thinking', 'Qwen3-VL 235B-A22B Thinking', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
  }),
  model('qwen', 'qwen3-vl-235b-a22b-instruct', 'Qwen3-VL 235B-A22B Instruct', {
    capabilities: visionCapabilities(),
  }),
  model('qwen', 'qwen3-vl-32b-instruct', 'Qwen3-VL 32B Instruct', {
    capabilities: visionCapabilities(),
  }),
  model('qwen', 'qwen3-vl-30b-a3b-thinking', 'Qwen3-VL 30B-A3B Thinking', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
  }),
  model('qwen', 'qwen3-vl-30b-a3b-instruct', 'Qwen3-VL 30B-A3B Instruct', {
    capabilities: visionCapabilities(),
  }),
  model('qwen', 'qwen3-vl-8b-thinking', 'Qwen3-VL 8B Thinking', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
  }),
  model('qwen', 'qwen3-vl-8b-instruct', 'Qwen3-VL 8B Instruct', {
    capabilities: visionCapabilities(),
  }),
  model('qwen', 'qwen3-next-80b-a3b-thinking', 'Qwen3-Next 80B-A3B Thinking', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
  }),
  model('qwen', 'qwen3-next-80b-a3b-instruct', 'Qwen3-Next 80B-A3B Instruct', {
    capabilities: textCapabilities(),
  }),
  model('qwen', 'qwen3-235b-a22b-thinking-2507', 'Qwen3 235B-A22B Thinking 2507', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
  }),
  model('qwen', 'qwen3-235b-a22b-2507', 'Qwen3 235B-A22B 2507', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-235b-a22b', 'Qwen3 235B-A22B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-30b-a3b-thinking-2507', 'Qwen3 30B-A3B Thinking 2507', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: alwaysThinking(),
  }),
  model('qwen', 'qwen3-30b-a3b-instruct-2507', 'Qwen3 30B-A3B Instruct 2507', {
    capabilities: textCapabilities(),
  }),
  model('qwen', 'qwen3-30b-a3b', 'Qwen3 30B-A3B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-32b', 'Qwen3 32B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-14b', 'Qwen3 14B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen3-8b', 'Qwen3 8B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen-plus', 'Qwen-Plus', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen-plus-2025-07-28', 'Qwen-Plus 2025-07-28', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen-turbo', 'Qwen-Turbo', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('qwen', 'qwen-max', 'Qwen-Max', { capabilities: visionCapabilities() }),
  model('qwen', 'qwen-long', 'Qwen-Long', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('qwen', 'qwen2.5-max', 'Qwen2.5-Max', {
    capabilities: visionCapabilities(),
  }),
  model('qwen', 'qwen2.5-72b-instruct', 'Qwen2.5 72B Instruct', {
    capabilities: textCapabilities(),
  }),
  model('qwen', 'qwen2.5-7b-instruct', 'Qwen2.5 7B Instruct', {
    capabilities: textCapabilities(),
    aliases: ['qwen-2.5-7b-instruct'],
  }),
  model('qwen', 'qwen2.5-vl-72b-instruct', 'Qwen2.5 VL 72B Instruct', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('qwen', 'qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B Instruct', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('qwen', 'qwen2-vl-72b-instruct', 'Qwen2 VL 72B Instruct', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('qwen', 'qwq-32b', 'QwQ 32B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
  }),
  model('qwen', 'qwen-math-plus', 'Qwen-Math-Plus', {
    capabilities: textCapabilities({ tools: false }),
  }),
]

const MOONSHOT: readonly BuiltinModelRecord[] = [
  model('moonshot', 'kimi-k3', 'Kimi K3', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
    aliases: ['moonshot/kimi-k3'],
  }),
  model('moonshot', 'kimi-k2.5', 'Kimi K2.5', {
    capabilities: visionCapabilities({
      thinking: true,
      videoInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'kimi-k2.6', 'Kimi K2.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code 高速版', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'moonshot-v1-8k', 'Moonshot V1 8K', {
    capabilities: textCapabilities({ tools: false }),
    aliases: ['moonshot-v1-8k-vision-preview'],
  }),
  model('moonshot', 'moonshot-v1-32k', 'Moonshot V1 32K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('moonshot', 'moonshot-v1-128k', 'Moonshot V1 128K', {
    capabilities: textCapabilities({ tools: false }),
  }),
]

const XAI: readonly BuiltinModelRecord[] = [
  model('xai', 'grok-4.6', 'Grok 4.6', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.5', 'Grok 4.5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.3', 'Grok 4.3', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.20', 'Grok 4.20', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4', 'Grok 4', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('xai', 'grok-3', 'Grok 3', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('xai', 'grok-3-mini', 'Grok 3 Mini', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-2-vision-1212', 'Grok 2 Vision', {
    capabilities: visionCapabilities(),
  }),
]

const MISTRAL: readonly BuiltinModelRecord[] = [
  model('mistral', 'mistral-large-2512', 'Mistral Large 3', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'mistral-medium-3-5', 'Mistral Medium 3.5', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'mistral-small-3.2', 'Mistral Small 3.2', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'ministral-8b-2512', 'Ministral 8B', {
    capabilities: textCapabilities(),
  }),
  model('mistral', 'ministral-3b-2512', 'Ministral 3B', {
    capabilities: textCapabilities(),
  }),
  model('mistral', 'codestral-2508', 'Codestral', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('mistral', 'devstral-2512', 'Devstral', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('mistral', 'magistral-medium-2509', 'Magistral Medium', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('mistral', 'magistral-small-2509', 'Magistral Small', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('mistral', 'pixtral-large-2411', 'Pixtral Large', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'pixtral-12b-2409', 'Pixtral 12B', {
    capabilities: visionCapabilities(),
  }),
]

const COHERE: readonly BuiltinModelRecord[] = [
  model('cohere', 'command-a-plus-05-2026', 'Command A+', {
    capabilities: textCapabilities({ tools: true, webSearch: true }),
  }),
  model('cohere', 'command-a-03-2025', 'Command A', {
    capabilities: textCapabilities({ tools: true, webSearch: true }),
  }),
  model('cohere', 'command-r-plus', 'Command R+', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('cohere', 'command-r', 'Command R', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('cohere', 'command-light', 'Command Light', {
    capabilities: textCapabilities({ tools: false }),
  }),
]

const MINIMAX: readonly BuiltinModelRecord[] = [
  model('minimax', 'MiniMax-M3', 'MiniMax M3', {
    capabilities: visionCapabilities({ thinking: true, videoInput: true }),
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking',
      enabledValue: { type: 'adaptive' },
      disabledValue: { type: 'disabled' },
    },
    aliases: ['minimax-m3'],
    source: source('https://platform.minimax.io/docs/api-reference/text-chat-openai'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2.7', 'MiniMax M2.7', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2.7'],
    source: source('https://platform.minimax.io/docs/api-reference/text-chat-openai'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2.7-highspeed'],
    source: source('https://platform.minimax.io/docs/guides/pricing-paygo'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2.5', 'MiniMax M2.5', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2.5'],
    source: source('https://platform.minimax.io/docs/api-reference/text-chat-openai'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2.5-highspeed', 'MiniMax M2.5 Highspeed', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2.5-highspeed'],
    source: source('https://platform.minimax.io/docs/guides/pricing-paygo'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2.1', 'MiniMax M2.1', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2.1'],
    source: source('https://platform.minimax.io/docs/api-reference/text-chat-openai'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2.1-highspeed', 'MiniMax M2.1 Highspeed', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2.1-highspeed'],
    source: source('https://platform.minimax.io/docs/guides/pricing-paygo'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2', 'MiniMax M2', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2'],
    source: source('https://platform.minimax.io/docs/api-reference/text-chat-openai'),
    verificationStatus: 'official-api',
  }),
  model('minimax', 'MiniMax-M2-her', 'MiniMax M2 her', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m2-her'],
  }),
  model('minimax', 'MiniMax-M1', 'MiniMax M1', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    aliases: ['minimax-m1'],
  }),
  model('minimax', 'abab6.5s-chat', 'abab 6.5s', {
    capabilities: visionCapabilities(),
    aliases: ['abab6.5s'],
  }),
  model('minimax', 'abab6.5-chat', 'abab 6.5', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('minimax', 'MiniMax-VL-01', 'MiniMax VL 01', {
    capabilities: visionCapabilities(),
  }),
  model('minimax', 'MiniMax-Text-01', 'MiniMax Text 01', {
    capabilities: textCapabilities(),
  }),
  model('minimax', 'MiniMax-01', 'MiniMax 01', {
    capabilities: textCapabilities({ tools: false }),
  }),
]

const HUNYUAN: readonly BuiltinModelRecord[] = [
  model('hunyuan', 'hunyuan-turbo', '混元 Turbo', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('enable_thinking'),
  }),
  model('hunyuan', 'hunyuan-pro', '混元 Pro', {
    capabilities: textCapabilities(),
  }),
  model('hunyuan', 'hunyuan-large', '混元 Large', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('hunyuan', 'hunyuan-a13b', '混元 A13B', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking_budget', 32_768),
  }),
  model('hunyuan', 'hunyuan-a13b-instruct', '混元 A13B Instruct', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking_budget', 32_768),
  }),
  model('hunyuan', 'hunyuan-t1', '混元 T1', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking_budget', 32_768),
  }),
  model('hunyuan', 'hy4-preview', 'HY 4 Preview', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    thinkingConfig: {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'high',
      parameterPath: 'reasoning_effort',
    },
    reasoningEfforts: ['none', 'low', 'high'],
    aliases: ['hunyuan-4-preview'],
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hy3', 'HY 3', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    thinkingConfig: {
      mode: 'effort',
      defaultEnabled: true,
      defaultEffort: 'high',
      parameterPath: 'reasoning_effort',
    },
    reasoningEfforts: ['none', 'low', 'high'],
    aliases: ['hy3-preview', 'hunyuan-3'],
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hy-mt2-pro', 'HY-MT2 Pro', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hy-mt2-plus', 'HY-MT2 Plus', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hy-mt2-lite', 'HY-MT2 Lite', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hunyuan-role-latest', 'HY Role Latest', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hy-role', 'HY Role', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://cloud.tencent.com/document/product/1823/130051'),
    verificationStatus: 'official-api',
  }),
  model('hunyuan', 'hy-mt2-30b-a3b', 'HY-MT2 30B-A3B', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('hunyuan', 'hy-mt2-7b', 'HY-MT2 7B', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('hunyuan', 'hy-mt2-1.8b', 'HY-MT2 1.8B', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('hunyuan', 'hunyuan-vision', '混元 Vision', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('hunyuan', 'hunyuan-muse', '混元 Muse', {
    modality: 'image',
    capabilities: imageCapabilities(),
    aliases: ['hy-muse', 'HY-Muse'],
  }),
  model('hunyuan', 'hunyuan-muse-vision', '混元 Muse Vision', {
    capabilities: visionCapabilities({ tools: false }),
    aliases: ['hy-muse-vision'],
  }),
  model('hunyuan', 'hunyuan-image', '混元生图', {
    modality: 'image',
    capabilities: imageCapabilities(),
  }),
  model('hunyuan', 'hunyuan-video', '混元视频', {
    modality: 'video',
    capabilities: videoCapabilities(),
    aliases: ['hunyuan-video-3.0'],
  }),
]

const XIAOMI: readonly BuiltinModelRecord[] = [
  model('xiaomi', 'mimo-v2.5-pro', 'MiMo V2.5 Pro', {
    capabilities: textCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    aliases: ['xiaomi/mimo-v2.5-pro'],
    source: source('https://mimo.mi.com/docs/en-US/pricing'),
    verificationStatus: 'official-api',
  }),
  model('xiaomi', 'mimo-v2.5', 'MiMo V2.5', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      tools: true,
      structuredOutput: true,
      streaming: true,
      caching: true,
    }),
    contextWindow: 1_000_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    aliases: ['xiaomi/mimo-v2.5'],
    source: source('https://mimo.mi.com/docs/en-US/pricing'),
    verificationStatus: 'official-api',
  }),
  model('xiaomi', 'mimo-v2-pro', 'MiMo V2 Pro', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('xiaomi', 'mimo-v2-omni', 'MiMo V2 Omni', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      audioInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 128_000,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('xiaomi', 'mimo-v2-flash', 'MiMo V2 Flash', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('xiaomi', 'mimo-vl-7b', 'MiMo-VL 7B', {
    capabilities: visionCapabilities(),
  }),
]

/** Meta Muse model-card family; these are not models from the unrelated muse.ai service. */
const MUSE: readonly BuiltinModelRecord[] = [
  model('meta', 'muse-spark-1.3', 'Muse Spark 1.3', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: source('https://ai.developer.meta.com/docs/models/muse-spark-1.3'),
    verificationStatus: 'official-model-card',
  }),
  model('meta', 'muse-spark-1.2', 'Muse Spark 1.2', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: source('https://ai.developer.meta.com/docs/models/muse-spark-1.2'),
    verificationStatus: 'official-model-card',
  }),
  model('meta', 'muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('meta', 'muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('meta', 'muse-spark-1.1', 'Muse Spark 1.1', {
    capabilities: visionCapabilities({ fileInput: true, videoInput: true }),
    source: source('https://developer.meta.com/ai/models/muse-spark-1-1/'),
    verificationStatus: 'official-model-card',
  }),
  model('meta', 'muse-glimmer-30b', 'Muse Glimmer 30B', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
]

const MEITUAN: readonly BuiltinModelRecord[] = [
  model('meituan', 'LongCat-2.0', 'LongCat 2.0', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      streaming: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['longcat-2.0'],
    source: source('https://longcat.chat/platform/docs/zh/api/model'),
    verificationStatus: 'official-api',
  }),
]

const OPENCODE_OTHER: readonly BuiltinModelRecord[] = [
  model('other', 'omen-alpha', 'Omen Alpha', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['low', 'high'],
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
]

const DOUBAO: readonly BuiltinModelRecord[] = [
  model('doubao', 'doubao-seed-evolving', '豆包 Seed Evolving', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
    thinkingConfig: toggleThinking('thinking.type'),
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-2-1-pro-260628', '豆包 Seed 2.1 Pro', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-2.1-pro', 'doubao-seed-2-1-pro'],
    pricingModelId: 'doubao-seed-2.1-pro',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-2-1-turbo-260628', '豆包 Seed 2.1 Turbo', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-2.1-turbo', 'doubao-seed-2-1-turbo'],
    pricingModelId: 'doubao-seed-2.1-turbo',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-2-0-pro-260215', '豆包 Seed 2.0 Pro', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-2.0-pro', 'doubao-seed-2-0-pro'],
    pricingModelId: 'doubao-seed-2.0-pro',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-2-0-lite-260428', '豆包 Seed 2.0 Lite', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-2.0-lite', 'doubao-seed-2-0-lite', 'doubao-seed-2-0-lite-260215'],
    pricingModelId: 'doubao-seed-2.0-lite',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-2-0-mini-260428', '豆包 Seed 2.0 Mini', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-2.0-mini', 'doubao-seed-2-0-mini', 'doubao-seed-2-0-mini-260215'],
    pricingModelId: 'doubao-seed-2.0-mini',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-2-0-code-preview-260215', '豆包 Seed 2.0 Code Preview', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-2.0-code', 'doubao-seed-2-0-code'],
    pricingModelId: 'doubao-seed-2.0-code',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-character-260628', '豆包 Seed Character', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-character'],
    pricingModelId: 'doubao-seed-character',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-code-preview-251028', '豆包 Seed Code Preview', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-code'],
    pricingModelId: 'doubao-seed-code',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-1-6-flash-250828', '豆包 Seed 1.6 Flash', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-1.6-flash', 'doubao-seed-1-6-flash', 'doubao-seed-1-6-flash-250615'],
    pricingModelId: 'doubao-seed-1.6-flash',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-1-6-vision-250815', '豆包 Seed 1.6 Vision', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
      caching: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['doubao-seed-1.6-vision', 'doubao-seed-1-6-vision'],
    pricingModelId: 'doubao-seed-1.6-vision',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-1-5-pro-32k-250115', '豆包 1.5 Pro 32K', {
    capabilities: textCapabilities({ tools: true, caching: true }),
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    aliases: ['doubao-1.5-pro-32k', 'doubao-1-5-pro-32k'],
    pricingModelId: 'doubao-1.5-pro-32k',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-1-5-lite-32k-250115', '豆包 1.5 Lite 32K', {
    capabilities: textCapabilities({ tools: true, caching: true }),
    contextWindow: 32_768,
    maxOutputTokens: 12_288,
    aliases: ['doubao-1.5-lite-32k', 'doubao-1-5-lite-32k'],
    pricingModelId: 'doubao-1.5-lite-32k',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-1.5-vision-pro', '豆包 1.5 Vision Pro', {
    capabilities: visionCapabilities(),
    pricingModelId: 'doubao-1.5-vision-pro',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-translation-250915', '豆包 Seed Translation', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 4_096,
    maxOutputTokens: 3_072,
    aliases: ['doubao-seed-translation'],
    pricingModelId: 'doubao-seed-translation',
    verificationStatus: 'official-api',
  }),
  model('doubao', 'doubao-seed-1-6', '豆包 Seed 1.6', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      structuredOutput: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    thinkingConfig: toggleThinking('thinking.type'),
  }),
  model('doubao', 'doubao-seedream-4-0', 'Seedream 4.0', {
    modality: 'image',
    capabilities: imageCapabilities(),
    aliases: ['seedream-4.0'],
  }),
  model('doubao', 'doubao-seedance-1-0-pro', 'Seedance 1.0 Pro', {
    modality: 'video',
    capabilities: videoCapabilities(),
    aliases: ['seedance-1.0-pro'],
  }),
]

const BAIDU: readonly BuiltinModelRecord[] = [
  model('baidu', 'ernie-5.1', 'ERNIE 5.1', {
    capabilities: textCapabilities(),
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-5.0', 'ERNIE 5.0', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    thinkingConfig: toggleThinking('enable_thinking'),
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-5.0-thinking-preview', 'ERNIE 5.0 Thinking Preview', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    thinkingConfig: alwaysThinking('enable_thinking'),
    pricingModelId: 'ernie-5.0',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-5.0-thinking-latest', 'ERNIE 5.0 Thinking Latest', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    thinkingConfig: alwaysThinking('enable_thinking'),
    pricingModelId: 'ernie-5.0',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-5.0-thinking-exp', 'ERNIE 5.0 Thinking Exp', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    thinkingConfig: alwaysThinking('enable_thinking'),
    pricingModelId: 'ernie-5.0',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-4.5-turbo-128k', 'ERNIE 4.5 Turbo 128K', {
    capabilities: textCapabilities({ tools: false, caching: true, webSearch: true }),
    contextWindow: 131_072,
    maxOutputTokens: 12_288,
    aliases: ['ernie-4.5-turbo'],
    pricingModelId: 'ernie-4.5-turbo',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-4.5-turbo-32k', 'ERNIE 4.5 Turbo 32K', {
    capabilities: textCapabilities({ tools: false, caching: true, webSearch: true }),
    contextWindow: 32_768,
    maxOutputTokens: 12_288,
    pricingModelId: 'ernie-4.5-turbo',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-4.5-turbo-20260402', 'ERNIE 4.5 Turbo 20260402', {
    capabilities: textCapabilities({ tools: false, caching: true, webSearch: true }),
    contextWindow: 131_072,
    maxOutputTokens: 12_288,
    pricingModelId: 'ernie-4.5-turbo',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-4.5-turbo-vl', 'ERNIE 4.5 Turbo VL', {
    capabilities: visionCapabilities({ tools: false, caching: true, webSearch: true }),
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    pricingModelId: 'ernie-4.5-turbo-vl',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-4.5-turbo-vl-32k', 'ERNIE 4.5 Turbo VL 32K', {
    capabilities: visionCapabilities({ tools: false, caching: true, webSearch: true }),
    contextWindow: 32_768,
    maxOutputTokens: 12_288,
    pricingModelId: 'ernie-4.5-turbo-vl',
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-x1.1-preview', 'ERNIE X1.1 Preview', {
    capabilities: textCapabilities({ thinking: true, webSearch: true }),
    contextWindow: 65_536,
    maxOutputTokens: 65_536,
    thinkingConfig: alwaysThinking('enable_thinking'),
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-x1.1', 'ERNIE X1.1', {
    capabilities: textCapabilities({ thinking: true, webSearch: true }),
    contextWindow: 65_536,
    maxOutputTokens: 65_536,
    thinkingConfig: alwaysThinking('enable_thinking'),
    verificationStatus: 'official-api',
  }),
  model('baidu', 'ernie-4.0-turbo', 'ERNIE 4.0 Turbo', {
    capabilities: visionCapabilities({ tools: false, webSearch: true }),
  }),
  model('baidu', 'ernie-speed-128k', 'ERNIE Speed 128K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('baidu', 'ernie-lite-8k', 'ERNIE Lite 8K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('baidu', 'ernie-x1-turbo', 'ERNIE X1 Turbo', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: budgetThinking('thinking_budget', 32_768),
  }),
  model('baidu', 'ernie-vl-1.0', 'ERNIE-VL 1.0', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('baidu', 'ernie-image', 'ERNIE Image', {
    modality: 'image',
    capabilities: imageCapabilities(),
  }),
]

const STEPFUN: readonly BuiltinModelRecord[] = [
  model('stepfun', 'step-3.7-flash', 'Step 3.7 Flash', {
    capabilities: visionCapabilities({
      thinking: true,
      videoInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium', 'high'],
    source: source('https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-3.5-flash', 'Step 3.5 Flash', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 262_144,
    thinkingConfig: alwaysThinking(),
    source: source('https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-3.5-flash-2603', 'Step 3.5 Flash 2603', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 262_144,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['low', 'high'],
    source: source('https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-1o-turbo-vision', 'Step-1o Turbo Vision', {
    capabilities: visionCapabilities({ videoInput: true }),
    contextWindow: 32_768,
    source: source('https://platform.stepfun.com/docs/zh/guides/models/vision.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-3', 'Step-3', {
    capabilities: visionCapabilities({ tools: false, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('stepfun', 'step-2-16k', 'Step-2 16K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('stepfun', 'step-1v-8k', 'Step-1V 8K', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('stepfun', 'step-1o-vision-32k', 'Step-1o Vision 32K', {
    capabilities: visionCapabilities({ tools: false, thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('stepfun', 'step-1-flash', 'Step-1 Flash', {
    capabilities: textCapabilities({ tools: false }),
  }),
]

const BAICHUAN: readonly BuiltinModelRecord[] = [
  model('baichuan', 'Baichuan4', 'Baichuan 4', {
    capabilities: visionCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan4-Turbo', 'Baichuan 4 Turbo', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan4-Air', 'Baichuan 4 Air', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan3-Turbo', 'Baichuan 3 Turbo', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan3-Turbo-128k', 'Baichuan 3 Turbo 128K', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 131_072,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan2-Turbo', 'Baichuan 2 Turbo', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-M3-Plus', 'Baichuan M3 Plus', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-M3', 'Baichuan M3', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-M2-Plus', 'Baichuan M2 Plus', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-Omni-1.5', 'Baichuan Omni 1.5', {
    capabilities: visionCapabilities({ tools: false, audioInput: true }),
  }),
  model('baichuan', 'Baichuan-M2', 'Baichuan M2', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    contextWindow: 32_768,
    thinkingConfig: budgetThinking('thinking_budget', 16_384),
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
]

const SENSENOVA: readonly BuiltinModelRecord[] = [
  model('sensenova', 'SenseNova-V6-5-Pro', 'SenseNova V6.5 Pro', {
    capabilities: visionCapabilities({ tools: false, videoInput: true, thinking: true, streaming: true }),
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    thinkingConfig: toggleThinking('thinking.enabled'),
    aliases: ['SenseNova-V6.5-Pro'],
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseNova-V6-5-Turbo', 'SenseNova V6.5 Turbo', {
    capabilities: visionCapabilities({ tools: false, videoInput: true, thinking: true, streaming: true }),
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    thinkingConfig: toggleThinking('thinking.enabled'),
    aliases: ['SenseNova-V6.5-Turbo'],
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseNova-V6-Pro', 'SenseNova V6 Pro', {
    capabilities: visionCapabilities({ tools: false, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 16_384,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseNova-V6-Turbo', 'SenseNova V6 Turbo', {
    capabilities: visionCapabilities({ tools: false, videoInput: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 16_384,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseNova-V6-Reasoner', 'SenseNova V6 Reasoner', {
    capabilities: visionCapabilities({ tools: false, thinking: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 16_384,
    thinkingConfig: alwaysThinking('thinking.enabled'),
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-Vision', 'SenseChat Vision', {
    capabilities: visionCapabilities({ tools: false, streaming: true }),
    contextWindow: 16_384,
    maxOutputTokens: 16_384,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/mllm'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-Character-Pro', 'SenseChat Character Pro', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/llm/CharacterLLM'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-Character', 'SenseChat Character', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/llm/CharacterLLM'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-5', 'SenseChat 5', {
    capabilities: textCapabilities({ thinking: true, streaming: true }),
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium'],
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat', 'SenseChat', {
    capabilities: textCapabilities({ tools: false, streaming: true }),
    contextWindow: 4_096,
    maxOutputTokens: 2_048,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-Turbo', 'SenseChat Turbo', {
    capabilities: textCapabilities({ tools: false, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 2_048,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-5-Cantonese', 'SenseChat 5 Cantonese', {
    capabilities: textCapabilities({ tools: false, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 2_048,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode'),
    verificationStatus: 'official-api',
  }),
  model('sensenova', 'SenseChat-FunctionCall', 'SenseChat Function Call', {
    capabilities: textCapabilities({ tools: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 2_048,
    source: source('https://www.sensecore.cn/help/docs/model-as-a-service/nova/chat/ChatCompletions/FunctionCalling'),
    verificationStatus: 'official-api',
  }),
]

const SPARK: readonly BuiltinModelRecord[] = [
  model('spark', 'spark-x2', 'Spark X2', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
      streaming: true,
    }),
    contextWindow: 192_000,
    maxOutputTokens: 131_072,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    source: source('https://maas.xfyun.cn/modelSquare/base/2610636408864769'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-x2-flash', 'Spark X2 Flash', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
      streaming: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    source: source('https://maas.xfyun.cn/modelSquare/base/2611845619399681'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-x2.5-4b', 'Spark X2.5 4B', {
    capabilities: textCapabilities({ tools: true, streaming: true }),
    contextWindow: 1_000_000,
    source: source('https://maas.xfyun.cn/modelSquare/base/2624338172569611'),
    verificationStatus: 'official-model-card',
  }),
  model('spark', 'spark-x2.5-1.7b', 'Spark X2.5 1.7B', {
    capabilities: textCapabilities({ tools: true, streaming: true }),
    contextWindow: 1_000_000,
    source: source('https://maas.xfyun.cn/modelSquare/base/2624338063517705'),
    verificationStatus: 'official-model-card',
  }),
  model('spark', 'spark-4.0-ultra', '讯飞星火 4.0 Ultra', {
    capabilities: textCapabilities({ tools: true, webSearch: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 32_768,
    aliases: ['4.0Ultra'],
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-x1', '讯飞星火 X1', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
  }),
  model('spark', 'generalv3.5', '讯飞星火 Max', {
    capabilities: textCapabilities({ tools: true, webSearch: true, streaming: true }),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'max-32k', '讯飞星火 Max 32K', {
    capabilities: textCapabilities({ tools: true, webSearch: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 32_768,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'generalv3', '讯飞星火 Pro', {
    capabilities: textCapabilities({ tools: false, webSearch: true, streaming: true }),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'pro-128k', '讯飞星火 Pro 128K', {
    capabilities: textCapabilities({ tools: false, webSearch: true, streaming: true }),
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-lite', '讯飞星火 Lite', {
    capabilities: textCapabilities({ tools: false, streaming: true }),
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    aliases: ['lite'],
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
]

const PANGU: readonly BuiltinModelRecord[] = [
  model('pangu', 'openpangu-2.0-pro', 'openPangu 2.0 Pro', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      streaming: true,
    }),
    contextWindow: 512_000,
    maxOutputTokens: 128_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    verificationStatus: 'official-api',
  }),
  model('pangu', 'openpangu-2.0-flash', 'openPangu 2.0 Flash', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      streaming: true,
    }),
    contextWindow: 512_000,
    maxOutputTokens: 128_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    verificationStatus: 'official-api',
  }),
]

const YI: readonly BuiltinModelRecord[] = [
  model('yi', 'yi-large', 'Yi Large', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('yi', 'yi-large-turbo', 'Yi Large Turbo', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('yi', 'yi-lightning', 'Yi Lightning', {
    capabilities: textCapabilities(),
  }),
  model('yi', 'yi-vision', 'Yi Vision', { capabilities: visionCapabilities({ tools: false }) }),
  model('yi', 'yi-1.5-34b-chat', 'Yi 1.5 34B Chat', {
    capabilities: textCapabilities({ tools: false }),
  }),
]

const META: readonly BuiltinModelRecord[] = [
  model('meta', 'meta-llama/llama-4-maverick', 'Llama 4 Maverick', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('meta', 'meta-llama/llama-4-scout', 'Llama 4 Scout', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('meta', 'meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct', {
    capabilities: textCapabilities(),
  }),
  model('meta', 'meta-llama/llama-3.2-90b-vision-instruct', 'Llama 3.2 90B Vision', { capabilities: visionCapabilities() }),
  model('meta', 'meta-llama/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', { capabilities: visionCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-405b-instruct', 'Llama 3.1 405B Instruct', { capabilities: textCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct', {
    capabilities: textCapabilities(),
  }),
  model('meta', 'meta-llama/llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct', {
    capabilities: textCapabilities(),
  }),
]

const MICROSOFT: readonly BuiltinModelRecord[] = [
  model('microsoft', 'phi-4', 'Phi-4', { capabilities: textCapabilities({ tools: false }) }),
  model('microsoft', 'phi-4-mini-instruct', 'Phi-4 Mini Instruct', {
    capabilities: textCapabilities(),
  }),
  model('microsoft', 'phi-4-multimodal-instruct', 'Phi-4 Multimodal Instruct', {
    capabilities: visionCapabilities({ audioInput: true }),
  }),
]

const AMAZON: readonly BuiltinModelRecord[] = [
  model('amazon', 'amazon.nova-pro-v1:0', 'Amazon Nova Pro', {
    capabilities: visionCapabilities(),
  }),
  model('amazon', 'amazon.nova-lite-v1:0', 'Amazon Nova Lite', {
    capabilities: visionCapabilities(),
  }),
  model('amazon', 'amazon.nova-micro-v1:0', 'Amazon Nova Micro', {
    capabilities: textCapabilities(),
  }),
  model('amazon', 'amazon.nova-canvas-v1:0', 'Amazon Nova Canvas', {
    modality: 'image',
    capabilities: imageCapabilities(),
  }),
  model('amazon', 'amazon.nova-reel-v1:0', 'Amazon Nova Reel', {
    modality: 'video',
    capabilities: videoCapabilities(),
  }),
]

const AUDIO_MODELS: readonly BuiltinModelRecord[] = [
  model('openai', 'gpt-audio-1.5', 'GPT Audio 1.5', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-audio', 'GPT Audio', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-audio-mini', 'GPT Audio Mini', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-audio-preview', 'GPT-4o Audio Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-audio-preview', 'GPT-4o Mini Audio Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime-2.1', 'GPT Realtime 2.1', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
      thinking: true,
    }),
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-realtime-2.1-mini', 'GPT Realtime 2.1 Mini', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
      thinking: true,
    }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-realtime-2', 'GPT Realtime 2', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
      thinking: true,
    }),
    thinkingConfig: effortThinking('reasoning.effort'),
    reasoningEfforts: efforts,
  }),
  model('openai', 'gpt-realtime-1.5', 'GPT Realtime 1.5', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime', 'GPT Realtime', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime-mini', 'GPT Realtime Mini', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      vision: true,
      visionInput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-realtime-translate', 'GPT Realtime Translate', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-4o-realtime-preview', 'GPT-4o Realtime Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-realtime-preview', 'GPT-4o Mini Realtime Preview', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-tts', 'GPT-4o Mini TTS', {
    modality: 'speech',
    capabilities: audioCapabilities({ textInput: true }),
  }),
  model('openai', 'tts-1', 'TTS 1', {
    modality: 'speech',
    capabilities: audioCapabilities({ textInput: true }),
  }),
  model('openai', 'tts-1-hd', 'TTS 1 HD', {
    modality: 'speech',
    capabilities: audioCapabilities({ textInput: true }),
  }),
  model('openai', 'gpt-transcribe', 'GPT Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-live-transcribe', 'GPT Live Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
      streaming: true,
    }),
  }),
  model('openai', 'gpt-realtime-whisper', 'GPT Realtime Whisper', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
      streaming: true,
    }),
  }),
  model('openai', 'gpt-4o-transcribe', 'GPT-4o Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-4o-mini-transcribe', 'GPT-4o Mini Transcribe', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'gpt-4o-transcribe-diarize', 'GPT-4o Transcribe Diarize', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('openai', 'whisper-1', 'Whisper', {
    modality: 'transcription',
    capabilities: textCapabilities({
      tools: false,
      audioInput: true,
      textOutput: true,
    }),
  }),
  model('google', 'gemini-2.5-flash-native-audio-preview-12-2025', 'Gemini 2.5 Flash Native Audio Preview 12-2025', {
    modality: 'speech',
    capabilities: audioCapabilities({
      audioInput: true,
      videoInput: true,
      textInput: true,
      textOutput: true,
      tools: true,
      webSearch: true,
      streaming: true,
    }),
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    aliases: ['gemini-2.5-flash-native-audio'],
    source: source('https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025'),
    verificationStatus: 'official-api',
  }),
]

const AI21: readonly BuiltinModelRecord[] = [
  model('ai21', 'jamba-1.6-large', 'Jamba 1.6 Large', {
    capabilities: textCapabilities(),
  }),
  model('ai21', 'jamba-1.6-mini', 'Jamba 1.6 Mini', {
    capabilities: textCapabilities(),
  }),
  model('ai21', 'jamba-1.5-large', 'Jamba 1.5 Large', {
    capabilities: textCapabilities(),
  }),
  model('ai21', 'jamba-1.5-mini', 'Jamba 1.5 Mini', {
    capabilities: textCapabilities(),
  }),
]

const PERPLEXITY: readonly BuiltinModelRecord[] = [
  model('perplexity', 'sonar', 'Sonar', {
    capabilities: textCapabilities({ tools: false, webSearch: true }),
  }),
  model('perplexity', 'sonar-pro', 'Sonar Pro', {
    capabilities: textCapabilities({ tools: false, webSearch: true }),
  }),
  model('perplexity', 'sonar-reasoning', 'Sonar Reasoning', {
    capabilities: textCapabilities({ tools: false, webSearch: true, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('perplexity', 'sonar-reasoning-pro', 'Sonar Reasoning Pro', {
    capabilities: textCapabilities({ tools: false, webSearch: true, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('perplexity', 'sonar-deep-research', 'Sonar Deep Research', {
    capabilities: textCapabilities({ tools: false, webSearch: true, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
]

const INTERNLM: readonly BuiltinModelRecord[] = [
  model('internlm', 'intern-s2-preview-397b', 'Intern-S2-Preview-397B', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    aliases: ['intern-latest'],
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s2-preview-35b', 'Intern-S2-Preview-35B', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    aliases: ['intern-s2-preview'],
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s1-pro', 'Intern-S1-Pro', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true, webSearch: true }),
    contextWindow: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s1', 'Intern-S1', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 32_768,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s1-mini', 'Intern-S1-Mini', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 32_768,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    verificationStatus: 'official-api',
  }),
  model('internlm', 'internvl3.5-241b-a28b', 'InternVL3.5-241B-A28B', {
    capabilities: visionCapabilities({ tools: false, streaming: true }),
    contextWindow: 32_768,
    aliases: ['internvl3.5-latest', 'internvl-latest'],
    verificationStatus: 'official-api',
  }),
  model('internlm', 'internvl3-38b', 'InternVL 3 38B', {
    capabilities: visionCapabilities({ tools: false }),
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    source: source('https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j'),
    verificationStatus: 'official-api',
  }),
]

/**
 * The complete built-in catalogue.  Keep this list independent from
 * `PROVIDER_PRESETS`: adding a connection must never be required for a model
 * to appear here.  User-created records are merged by the catalog service.
 */
export const BUILTIN_MODEL_CATALOG: readonly BuiltinModelRecord[] = [...OPENAI, ...OPENAI_MEDIA, ...ANTHROPIC, ...GOOGLE, ...DEEPSEEK, ...ZHIPU, ...QWEN, ...MOONSHOT, ...XAI, ...MISTRAL, ...COHERE, ...MINIMAX, ...HUNYUAN, ...XIAOMI, ...MUSE, ...MEITUAN, ...OPENCODE_OTHER, ...DOUBAO, ...BAIDU, ...STEPFUN, ...BAICHUAN, ...SENSENOVA, ...SPARK, ...PANGU, ...YI, ...META, ...MICROSOFT, ...AMAZON, ...AUDIO_MODELS, ...AI21, ...PERPLEXITY, ...INTERNLM]

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
