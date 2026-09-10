import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, effortThinking, alwaysThinking, efforts, source } from '../helpers'

export const STEPFUN: readonly BuiltinModelRecord[] = [
  model('stepfun', 'step-3.7-flash', 'Step 3.7 Flash', {
    capabilities: visionCapabilities({
      thinking: true,
      videoInput: true,
      tools: true,
    }),
    contextWindow: 262_144,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['low', 'medium', 'high'],
    source: source('https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-3.5-flash', 'Step 3.5 Flash', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 262_144,
    thinkingConfig: alwaysThinking(),
    source: source('https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-3.5-flash-2603', 'Step 3.5 Flash 2603', {
    capabilities: textCapabilities({ thinking: true, tools: true }),
    contextWindow: 262_144,
    thinkingConfig: effortThinking('reasoning_effort', 'high'),
    reasoningEfforts: ['low', 'high'],
    source: source('https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-1o-turbo-vision', 'Step-1o Turbo Vision', {
    capabilities: visionCapabilities({ videoInput: true }),
    contextWindow: 32_768,
    source: source('https://platform.stepfun.com/docs/zh/guides/models/vision.md'),
    verificationStatus: 'official-api',
  }),
  model('stepfun', 'step-3', 'Step-3', {
    capabilities: visionCapabilities({ tools: false, thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
  model('stepfun', 'step-2-16k', 'Step-2 16K', {
    capabilities: textCapabilities({ tools: false }),
  }),
  model('stepfun', 'step-1v-8k', 'Step-1V 8K', {
    capabilities: visionCapabilities({ tools: false }),
  }),
  model('stepfun', 'step-1o-vision-32k', 'Step-1o Vision 32K', {
    capabilities: visionCapabilities({ tools: false, thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('stepfun', 'step-1-flash', 'Step-1 Flash', {
    capabilities: textCapabilities({ tools: false }),
  }),
]
