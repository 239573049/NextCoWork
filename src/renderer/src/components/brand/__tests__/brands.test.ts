import { describe, expect, it } from 'vitest'
import { BRANDS, resolveBrand, type Brand } from '../brands'

/**
 * 每个牌子至少一个真实样本。这张表同时干两件事:
 *
 * 1. **覆盖**:`BRANDS` 里加了一项却忘了在 `RULES` 里加规则,
 *    下面「每个 Brand 都至少有一条样本」那条会挂 —— 否则那就是一个
 *    永远匹配不到的死项,不会有任何人发现。
 * 2. **顺序**:几条是刻意挑的对抗样本 —— `claude-*` 不能落到 anthropic、
 *    `kimi-*` 不能落到 moonshot、`Ollama` 不能落到 meta。
 *    正则表顺序错一位,logo 就显示成别家的,而且没有任何人会报这个 bug。
 */
const SAMPLES: readonly (readonly [string, Brand])[] = [
  ['claude-fable-5-1', 'claude'],
  ['Anthropic', 'anthropic'],
  ['gpt-4o', 'openai'],
  ['o3-mini', 'openai'],
  ['deepseek-v3', 'deepseek'],
  ['qwen-max', 'qwen'],
  ['kimi-k2', 'kimi'],
  ['moonshot-v1-128k', 'moonshot'],
  ['glm-4.6', 'zhipu'],
  ['gemini-2.5-pro', 'gemini'],
  ['grok-4', 'xai'],
  ['llama-3.3-70b', 'meta'],
  ['mistral-large', 'mistral'],
  ['abab6.5s', 'minimax'],
  ['doubao-pro-32k', 'doubao'],
  ['火山方舟', 'volcengine'],
  ['hunyuan-turbo', 'hunyuan'],
  ['spark-4.0', 'spark'],
  ['step-2', 'stepfun'],
  ['baichuan4', 'baichuan'],
  ['yi-large', 'yi'],
  ['OpenRouter', 'openrouter'],
  ['SiliconCloud', 'siliconcloud'],
  ['Ollama', 'ollama'],
  ['LM Studio', 'lmstudio'],
  ['Groq', 'groq'],
  ['Together AI', 'together'],
  ['Fireworks AI', 'fireworks'],
  ['sonar-pro', 'perplexity'],
  ['AWS Bedrock', 'bedrock'],
  ['Vertex AI', 'vertexai'],
  ['Azure', 'azure']
]

describe('resolveBrand', () => {
  it.each(SAMPLES)('%s → %s', (input, expected) => {
    expect(resolveBrand(input)).toBe(expected)
  })

  it('每个 Brand 都至少有一条样本 —— 漏了就是有牌子永远匹配不到', () => {
    const covered = new Set<Brand>(SAMPLES.map(([, b]) => b))
    expect(BRANDS.filter((b) => !covered.has(b))).toEqual([])
  })

  describe('顺序敏感的对抗样本', () => {
    it('claude 排在 anthropic 前 —— 模型显示 Claude 字形而不是 Anthropic 的 A', () => {
      expect(resolveBrand('claude-3-5-sonnet')).toBe('claude')
    })

    it('kimi 排在 moonshot 前 —— 两个字形都有,各显示各的', () => {
      expect(resolveBrand('kimi-latest')).toBe('kimi')
    })

    it('doubao 排在 volcengine 前 —— 火山引擎上的豆包该显示豆包', () => {
      expect(resolveBrand('doubao-1.5-pro')).toBe('doubao')
    })

    it('★ ollama 排在 meta 前 ——「Ollama」里含着「llama」', () => {
      expect(resolveBrand('Ollama')).toBe('ollama')
      // 但 codellama 仍然要落到 meta:所以是靠顺序解决,不是靠 \bllama 收紧
      expect(resolveBrand('codellama-70b')).toBe('meta')
    })

    it('「Azure OpenAI」显示 OpenAI 而不是 Azure —— 用户关心的是模型家族', () => {
      expect(resolveBrand('Azure OpenAI')).toBe('openai')
      expect(resolveBrand('Azure')).toBe('azure')
    })
  })

  describe('短 token 的词边界 —— 这是用正则不用 includes 的全部理由', () => {
    it('o1/o3/o4 不在别的名字中间误命中', () => {
      expect(resolveBrand('deepseek-r1')).toBe('deepseek')
      expect(resolveBrand('mono1x')).toBeNull()
      expect(resolveBrand('proto3-model')).toBeNull()
    })

    it('meta 不匹配 metallama 里的 meta(而 llama 规则会先接住它)', () => {
      expect(resolveBrand('metallama')).toBe('meta')
      expect(resolveBrand('metadata-tool')).toBeNull()
    })
  })

  describe('中文名 —— 设置页里供应商名是用户自己填的', () => {
    it.each([
      ['深度求索', 'deepseek'],
      ['通义千问', 'qwen'],
      ['智谱清言', 'zhipu'],
      ['月之暗面', 'moonshot'],
      ['腾讯混元', 'hunyuan'],
      ['讯飞星火', 'spark'],
      ['百川智能', 'baichuan'],
      ['零一万物', 'yi'],
      ['硅基流动', 'siliconcloud']
    ] as const)('%s → %s', (input, expected) => {
      expect(resolveBrand(input)).toBe(expected)
    })
  })

  describe('多候选', () => {
    it('第一个命中的赢', () => {
      expect(resolveBrand('claude-fable-5-1', 'DeepSeek')).toBe('claude')
    })

    it('聚合商 provider 认不出时,退到模型别名上', () => {
      expect(resolveBrand('RoutinAI', 'claude-fable-5-1')).toBe('claude')
    })

    it('跳过 undefined 和空串,不当成命中', () => {
      expect(resolveBrand(undefined, '', 'qwen-max')).toBe('qwen')
    })
  })

  describe('认不出是正常路径,不是错误', () => {
    it.each([['RoutinAI'], ['我司内部网关'], ['']])('%s → null', (input) => {
      expect(resolveBrand(input)).toBeNull()
    })

    it('一个候选都没有也返回 null', () => {
      expect(resolveBrand()).toBeNull()
    })
  })
})
