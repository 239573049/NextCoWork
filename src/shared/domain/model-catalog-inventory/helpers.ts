import type { ModelCapabilities, ModelModality, RequestAdapterConfig, ThinkingConfig } from '../provider'
import type { ModelCatalogVerificationStatus } from '../model-catalog'
import type { BuiltinModelRecord, ReasoningEffort } from './types'
import { manufacturer } from './manufacturers'

export const MODEL_CATALOG_FETCHED_AT = '2026-09-05'

export const source = (url: string): { url: string; fetchedAt: string } => ({
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

export const OPENCODE_GO_SOURCE = source('https://opencode.ai/docs/go/')

export const efforts = ['minimal', 'low', 'medium', 'high', 'max'] as const
export const openAiModernEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const openAiAstraEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const textCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
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

export const visionCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  // Image content parts and uploaded/document files are separate upstream
  // capabilities. Never infer File support merely because Vision is present.
  textCapabilities({ vision: true, visionInput: true, ...overrides })

export const imageCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({
    tools: false,
    textInput: true,
    textOutput: false,
    imageOutput: true,
    structuredOutput: false,
    ...overrides,
  })

export const videoCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({
    tools: false,
    textOutput: false,
    videoOutput: true,
    structuredOutput: false,
    ...overrides,
  })

export const audioCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities =>
  textCapabilities({
    tools: false,
    textOutput: false,
    audioOutput: true,
    structuredOutput: false,
    ...overrides,
  })

export const unsupportedThinking: ThinkingConfig = {
  mode: 'unsupported',
  defaultEnabled: false,
}
export const toggleThinking = (parameterPath = 'thinking'): ThinkingConfig => ({
  mode: 'toggle',
  defaultEnabled: false,
  parameterPath,
})
export const effortThinking = (parameterPath: string, defaultEffort: ReasoningEffort = 'medium'): ThinkingConfig => ({
  mode: 'effort',
  defaultEnabled: true,
  defaultEffort,
  parameterPath,
})
export const budgetThinking = (parameterPath: string, budget = 32_768): ThinkingConfig => ({
  mode: 'budget',
  defaultEnabled: true,
  defaultBudgetTokens: budget,
  parameterPath,
})
export const alwaysThinking = (parameterPath = 'enable_thinking'): ThinkingConfig => ({
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

/** Build one catalogue row. The one factory every vendor file goes through. */
export function model(manufacturerId: string, id: string, displayName: string, options: ModelOptions = {}): BuiltinModelRecord {
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
