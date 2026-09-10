import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, source, OPENCODE_GO_SOURCE } from '../helpers'

export const XIAOMI: readonly BuiltinModelRecord[] = [
  model('xiaomi', 'mimo-v2.5-pro', 'MiMo V2.5 Pro', {
    capabilities: textCapabilities({ thinking: true }),
    contextWindow: 1_000_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    aliases: ['xiaomi/mimo-v2.5-pro'],
    source: source('https://mimo.mi.com/docs/en-US/pricing'),
    verificationStatus: 'official-api',
  }),
  model('xiaomi', 'mimo-v2.5', 'MiMo V2.5', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      tools: true,
      structuredOutput: true,
      streaming: true,
      caching: true,
    }),
    contextWindow: 1_000_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    aliases: ['xiaomi/mimo-v2.5'],
    source: source('https://mimo.mi.com/docs/en-US/pricing'),
    verificationStatus: 'official-api',
  }),
  model('xiaomi', 'mimo-v2-pro', 'MiMo V2 Pro', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('xiaomi', 'mimo-v2-omni', 'MiMo V2 Omni', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      audioInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 128_000,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('xiaomi', 'mimo-v2-flash', 'MiMo V2 Flash', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('xiaomi', 'mimo-vl-7b', 'MiMo-VL 7B', {
    capabilities: visionCapabilities(),
  }),
]
