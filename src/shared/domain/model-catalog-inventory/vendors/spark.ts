import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, toggleThinking, source } from '../helpers'

export const SPARK: readonly BuiltinModelRecord[] = [
  model('spark', 'spark-x2', 'Spark X2', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
      streaming: true,
    }),
    contextWindow: 192_000,
    maxOutputTokens: 131_072,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    source: source('https://maas.xfyun.cn/modelSquare/base/2610636408864769'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-x2-flash', 'Spark X2 Flash', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      webSearch: true,
      streaming: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    source: source('https://maas.xfyun.cn/modelSquare/base/2611845619399681'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-x2.5-4b', 'Spark X2.5 4B', {
    capabilities: textCapabilities({ tools: true, streaming: true }),
    contextWindow: 1_000_000,
    source: source('https://maas.xfyun.cn/modelSquare/base/2624338172569611'),
    verificationStatus: 'official-model-card',
  }),
  model('spark', 'spark-x2.5-1.7b', 'Spark X2.5 1.7B', {
    capabilities: textCapabilities({ tools: true, streaming: true }),
    contextWindow: 1_000_000,
    source: source('https://maas.xfyun.cn/modelSquare/base/2624338063517705'),
    verificationStatus: 'official-model-card',
  }),
  model('spark', 'spark-4.0-ultra', '讯飞星火 4.0 Ultra', {
    capabilities: textCapabilities({ tools: true, webSearch: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 32_768,
    aliases: ['4.0Ultra'],
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-x1', '讯飞星火 X1', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking.type'),
  }),
  model('spark', 'generalv3.5', '讯飞星火 Max', {
    capabilities: textCapabilities({ tools: true, webSearch: true, streaming: true }),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'max-32k', '讯飞星火 Max 32K', {
    capabilities: textCapabilities({ tools: true, webSearch: true, streaming: true }),
    contextWindow: 32_768,
    maxOutputTokens: 32_768,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'generalv3', '讯飞星火 Pro', {
    capabilities: textCapabilities({ tools: false, webSearch: true, streaming: true }),
    contextWindow: 8_192,
    maxOutputTokens: 8_192,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'pro-128k', '讯飞星火 Pro 128K', {
    capabilities: textCapabilities({ tools: false, webSearch: true, streaming: true }),
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
  model('spark', 'spark-lite', '讯飞星火 Lite', {
    capabilities: textCapabilities({ tools: false, streaming: true }),
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    aliases: ['lite'],
    source: source('https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html'),
    verificationStatus: 'official-api',
  }),
]
