import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, effortThinking, budgetThinking, efforts, source } from '../helpers'

export const ZHIPU: readonly BuiltinModelRecord[] = [
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
