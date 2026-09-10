import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, imageCapabilities, toggleThinking, budgetThinking, alwaysThinking } from '../helpers'

export const BAIDU: readonly BuiltinModelRecord[] = [
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
