import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, effortThinking, efforts } from '../helpers'

export const YI: readonly BuiltinModelRecord[] = [
  model('yi', 'yi-large', 'Yi Large', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('yi', 'yi-large-turbo', 'Yi Large Turbo', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('yi', 'yi-lightning', 'Yi Lightning', {
    capabilities: textCapabilities(),
  }),
  model('yi', 'yi-vision', 'Yi Vision', { capabilities: visionCapabilities({ tools: false }) }),
  model('yi', 'yi-1.5-34b-chat', 'Yi 1.5 34B Chat', {
    capabilities: textCapabilities({ tools: false }),
  }),
]
