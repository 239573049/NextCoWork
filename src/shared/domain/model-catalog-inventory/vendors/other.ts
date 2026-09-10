import type { BuiltinModelRecord } from '../types'
import { model, visionCapabilities, effortThinking, OPENCODE_GO_SOURCE } from '../helpers'

export const OPENCODE_OTHER: readonly BuiltinModelRecord[] = [
  model('other', 'omen-alpha', 'Omen Alpha', {
    capabilities: visionCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['low', 'high'],
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
]
