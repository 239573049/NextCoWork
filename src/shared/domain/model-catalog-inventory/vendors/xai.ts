import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, effortThinking, efforts } from '../helpers'

export const XAI: readonly BuiltinModelRecord[] = [
  // 需求：上新 grok-4.7，上下文窗口按官方口径为 500K（4.6 系列沿用 helpers 的
  // 200K 默认值未单独核实过，两者互不关联，别顺手把 4.6 也改成 500K）。
  model('xai', 'grok-4.7', 'Grok 4.7', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
    contextWindow: 500_000,
  }),
  model('xai', 'grok-4.6', 'Grok 4.6', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.5', 'Grok 4.5', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.3', 'Grok 4.3', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4.20', 'Grok 4.20', {
    capabilities: visionCapabilities({ thinking: true, webSearch: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-4', 'Grok 4', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('xai', 'grok-3', 'Grok 3', {
    capabilities: visionCapabilities({ webSearch: true }),
  }),
  model('xai', 'grok-3-mini', 'Grok 3 Mini', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('xai', 'grok-2-vision-1212', 'Grok 2 Vision', {
    capabilities: visionCapabilities(),
  }),
]
