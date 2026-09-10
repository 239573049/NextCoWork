import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities } from '../helpers'

export const MICROSOFT: readonly BuiltinModelRecord[] = [
  model('microsoft', 'phi-4', 'Phi-4', { capabilities: textCapabilities({ tools: false }) }),
  model('microsoft', 'phi-4-mini-instruct', 'Phi-4 Mini Instruct', {
    capabilities: textCapabilities(),
  }),
  model('microsoft', 'phi-4-multimodal-instruct', 'Phi-4 Multimodal Instruct', {
    capabilities: visionCapabilities({ audioInput: true }),
  }),
]
