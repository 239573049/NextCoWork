import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, OPENCODE_GO_SOURCE } from '../helpers'

export const MOONSHOT: readonly BuiltinModelRecord[] = [
  model('moonshot', 'kimi-k3', 'Kimi K3', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
    aliases: ['moonshot/kimi-k3'],
  }),
  model('moonshot', 'kimi-k2.5', 'Kimi K2.5', {
    capabilities: visionCapabilities({
      thinking: true,
      videoInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    thinkingConfig: { mode: 'always', defaultEnabled: true },
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'kimi-k2.6', 'Kimi K2.6', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code 高速版', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('moonshot', 'moonshot-v1-8k', 'Moonshot V1 8K', {
    capabilities: textCapabilities({ tools: false }),
    aliases: ['moonshot-v1-8k-vision-preview'],
  }),
  model('moonshot', 'moonshot-v1-32k', 'Moonshot V1 32K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('moonshot', 'moonshot-v1-128k', 'Moonshot V1 128K', {
    capabilities: textCapabilities({ tools: false }),
  }),
]
