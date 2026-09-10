import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, imageCapabilities, videoCapabilities, toggleThinking, budgetThinking, source } from '../helpers'

export const HUNYUAN: readonly BuiltinModelRecord[] = [
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
