import type { ThinkingConfig } from '../../provider'
import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, effortThinking, budgetThinking, source } from '../helpers'

/*
  ★★ DeepSeek 思考模式的硬校验:带 tools 时,历史每一轮的 reasoning_text 必须
  **完整回传**,缺了整轮 400(`The \`reasoning_text\` in the thinking mode must be
  passed back to the API`)。而默认回传方言是官方 OpenAI 那套 `opaque-only`(它给
  `content` 的上限是 0,恰好禁止正文)—— 两家互斥,所以这家**显式**声明。

  声明优先于模型名启发式:名字将来改了也不会静默掉回错误的一支。
*/
const DEEPSEEK_EFFORT_THINKING: ThinkingConfig = {
  ...effortThinking('reasoning_effort', 'high'),
  reasoningReplay: 'text-required'
}

export const DEEPSEEK: readonly BuiltinModelRecord[] = [
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
    thinkingConfig: DEEPSEEK_EFFORT_THINKING,
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
    thinkingConfig: DEEPSEEK_EFFORT_THINKING,
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
    thinkingConfig: DEEPSEEK_EFFORT_THINKING,
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
    thinkingConfig: DEEPSEEK_EFFORT_THINKING,
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
