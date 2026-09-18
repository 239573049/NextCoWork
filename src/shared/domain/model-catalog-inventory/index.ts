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
 *
 * Data is organized one file per vendor under `vendors/`; `AUDIO_MODELS` is the
 * one exception, grouped by modality since speech/audio models span vendors.
 */
export type { BuiltinModelRecord, ModelManufacturer, ReasoningEffort } from './types'
export { MODEL_MANUFACTURERS, manufacturerForModelId } from './manufacturers'
export { MODEL_CATALOG_FETCHED_AT } from './helpers'

/*
 * ★★ Ollama 的思考线形由 `model-binding.ts` 用在「模型绑到 Ollama 系供应商」
 * 这条路径上 —— 它不是某一个条目的私有数据,是那家供应商对**所有**模型的线形,
 * 所以从目录入口导出(见 vendors/ollama.ts 的文件头)。
 */
export { OLLAMA_REASONING_EFFORTS, OLLAMA_STANDARD_THINKING } from './vendors/ollama'

import type { BuiltinModelRecord } from './types'
import type { UpstreamProtocol } from '../provider'
import { OPENAI, OPENAI_MEDIA } from './vendors/openai'
import { OLLAMA } from './vendors/ollama'
import { ANTHROPIC } from './vendors/anthropic'
import { GOOGLE } from './vendors/google'
import { DEEPSEEK } from './vendors/deepseek'
import { ZHIPU } from './vendors/zhipu'
import { QWEN } from './vendors/qwen'
import { MOONSHOT } from './vendors/moonshot'
import { XAI } from './vendors/xai'
import { MISTRAL } from './vendors/mistral'
import { COHERE } from './vendors/cohere'
import { MINIMAX } from './vendors/minimax'
import { HUNYUAN } from './vendors/hunyuan'
import { XIAOMI } from './vendors/xiaomi'
import { MUSE, META } from './vendors/meta'
import { MEITUAN } from './vendors/meituan'
import { OPENCODE_OTHER } from './vendors/other'
import { DOUBAO } from './vendors/doubao'
import { BAIDU } from './vendors/baidu'
import { STEPFUN } from './vendors/stepfun'
import { BAICHUAN } from './vendors/baichuan'
import { SENSENOVA } from './vendors/sensenova'
import { SPARK } from './vendors/spark'
import { PANGU } from './vendors/pangu'
import { YI } from './vendors/yi'
import { MICROSOFT } from './vendors/microsoft'
import { AMAZON } from './vendors/amazon'
import { AUDIO_MODELS } from './vendors/audio'
import { AI21 } from './vendors/ai21'
import { PERPLEXITY } from './vendors/perplexity'
import { INTERNLM } from './vendors/internlm'

/**
 * The complete built-in catalogue.  Keep this list independent from
 * `PROVIDER_PRESETS`: adding a connection must never be required for a model
 * to appear here.  User-created records are merged by the catalog service.
 */
export const BUILTIN_MODEL_CATALOG: readonly BuiltinModelRecord[] = [
  ...OPENAI,
  ...OLLAMA,
  ...OPENAI_MEDIA,
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
  ...MEITUAN,
  ...OPENCODE_OTHER,
  ...DOUBAO,
  ...BAIDU,
  ...STEPFUN,
  ...BAICHUAN,
  ...SENSENOVA,
  ...SPARK,
  ...PANGU,
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

/**
 * ★★ 厂商默认线形协议 —— 必须是**数据表**,不能散成各处的 `if (id.startsWith('claude'))`。
 * 「claude 系模型默认走 anthropic 线形」这条规则有三个消费方:内置种子
 * (`runtime.ts` 的 `builtinAlias`)、拉取模型列表(`ipc/provider.ts` 的 `setAliases`)
 * 和老库回填(`runtime.ts` 那段一次性迁移)。各写一遍分支,漏掉一处的表现是
 * 同一个模型在不同入口拿到不同协议,而且不报错。
 *
 * 只登记「线形错了有实质损失」的厂商。目前只有 anthropic:Claude 的思考、
 * prompt 缓存、工具语义只在 anthropic 线形上是完整的,聚合站的 OpenAI 兼容层
 * 常常把 `thinking` / `cache_control` 直接丢掉。别家(gpt、glm…)两种线形差异
 * 小得多,统一钉死反而剥夺了「跟随供应商」这个合理默认。
 */
const MANUFACTURER_DEFAULT_PROTOCOL: Readonly<Record<string, UpstreamProtocol>> = {
  anthropic: 'anthropic'
}

/**
 * 该模型按厂商归属应默认使用的线形协议;目录查不到或厂商未登记时返回 undefined ——
 * 含义是「跟随供应商协议」,不是「没有协议」。
 *
 * 聚合站的 `vendor/` 前缀 ID 与裸名等价(走 `findBuiltinModel` 的同一条匹配,
 * `anthropic/claude-fable-5.1` 命中 `claude-fable-5-1` 那条)。
 */
export function defaultProtocolForModel(modelId: string): UpstreamProtocol | undefined {
  const known = findBuiltinModel(modelId)
  const result = known === undefined ? undefined : MANUFACTURER_DEFAULT_PROTOCOL[known.manufacturerId]
  console.log('[debug-helper]', JSON.stringify(modelId), 'known=', known?.id, known?.manufacturerId, 'result=', result)
  return result
}
