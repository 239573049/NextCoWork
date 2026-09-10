import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, effortThinking, efforts } from '../helpers'

export const MISTRAL: readonly BuiltinModelRecord[] = [
  model('mistral', 'mistral-large-2512', 'Mistral Large 3', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'mistral-medium-3-5', 'Mistral Medium 3.5', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'mistral-small-3.2', 'Mistral Small 3.2', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'ministral-8b-2512', 'Ministral 8B', {
    capabilities: textCapabilities(),
  }),
  model('mistral', 'ministral-3b-2512', 'Ministral 3B', {
    capabilities: textCapabilities(),
  }),
  model('mistral', 'codestral-2508', 'Codestral', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('mistral', 'devstral-2512', 'Devstral', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('mistral', 'magistral-medium-2509', 'Magistral Medium', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('mistral', 'magistral-small-2509', 'Magistral Small', {
    capabilities: textCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('mistral', 'pixtral-large-2411', 'Pixtral Large', {
    capabilities: visionCapabilities(),
  }),
  model('mistral', 'pixtral-12b-2409', 'Pixtral 12B', {
    capabilities: visionCapabilities(),
  }),
]
