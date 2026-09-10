import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, toggleThinking, source } from '../helpers'

export const MEITUAN: readonly BuiltinModelRecord[] = [
  model('meituan', 'LongCat-2.0', 'LongCat 2.0', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      streaming: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: toggleThinking('thinking.type'),
    aliases: ['longcat-2.0'],
    source: source('https://longcat.chat/platform/docs/zh/api/model'),
    verificationStatus: 'official-api',
  }),
]
