import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, effortThinking, efforts } from '../helpers'

export const PERPLEXITY: readonly BuiltinModelRecord[] = [
  model('perplexity', 'sonar', 'Sonar', {
    capabilities: textCapabilities({ tools: false, webSearch: true }),
  }),
  model('perplexity', 'sonar-pro', 'Sonar Pro', {
    capabilities: textCapabilities({ tools: false, webSearch: true }),
  }),
  model('perplexity', 'sonar-reasoning', 'Sonar Reasoning', {
    capabilities: textCapabilities({ tools: false, webSearch: true, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('perplexity', 'sonar-reasoning-pro', 'Sonar Reasoning Pro', {
    capabilities: textCapabilities({ tools: false, webSearch: true, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('perplexity', 'sonar-deep-research', 'Sonar Deep Research', {
    capabilities: textCapabilities({ tools: false, webSearch: true, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
]
