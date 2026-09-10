import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, effortThinking, budgetThinking, source } from '../helpers'

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
