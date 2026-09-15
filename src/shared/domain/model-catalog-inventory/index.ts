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
