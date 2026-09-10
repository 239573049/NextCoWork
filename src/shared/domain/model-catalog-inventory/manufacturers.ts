import type { ModelManufacturer } from './types'

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

/** Look up a manufacturer by ID, falling back to the catch-all `other` entry. */
export function manufacturer(id: string): ModelManufacturer {
  return MANUFACTURER_BY_ID.get(id) ?? MANUFACTURER_BY_ID.get('other')!
}
