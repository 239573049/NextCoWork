import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, toggleThinking, effortThinking, efforts, source, OPENCODE_GO_SOURCE } from '../helpers'

/** Meta Muse model-card family; these are not models from the unrelated muse.ai service. */

export const MUSE: readonly BuiltinModelRecord[] = [
  model('meta', 'muse-spark-1.3', 'Muse Spark 1.3', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: source('https://ai.developer.meta.com/docs/models/muse-spark-1.3'),
    verificationStatus: 'official-model-card',
  }),
  model('meta', 'muse-spark-1.2', 'Muse Spark 1.2', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: source('https://ai.developer.meta.com/docs/models/muse-spark-1.2'),
    verificationStatus: 'official-model-card',
  }),
  model('meta', 'muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('meta', 'muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', {
    capabilities: visionCapabilities({
      thinking: true,
      fileInput: true,
      videoInput: true,
      audioInput: true,
      tools: true,
      caching: true,
      structuredOutput: true,
    }),
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    source: OPENCODE_GO_SOURCE,
    verificationStatus: 'aggregator-reference',
  }),
  model('meta', 'muse-spark-1.1', 'Muse Spark 1.1', {
    capabilities: visionCapabilities({ fileInput: true, videoInput: true }),
    source: source('https://developer.meta.com/ai/models/muse-spark-1-1/'),
    verificationStatus: 'official-model-card',
  }),
  model('meta', 'muse-glimmer-30b', 'Muse Glimmer 30B', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: effortThinking('reasoning_effort'),
    reasoningEfforts: efforts,
  }),
]

export const META: readonly BuiltinModelRecord[] = [
  model('meta', 'meta-llama/llama-4-maverick', 'Llama 4 Maverick', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('meta', 'meta-llama/llama-4-scout', 'Llama 4 Scout', {
    capabilities: visionCapabilities({ thinking: true }),
    thinkingConfig: toggleThinking('thinking'),
  }),
  model('meta', 'meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct', {
    capabilities: textCapabilities(),
  }),
  model('meta', 'meta-llama/llama-3.2-90b-vision-instruct', 'Llama 3.2 90B Vision', { capabilities: visionCapabilities() }),
  model('meta', 'meta-llama/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision', { capabilities: visionCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-405b-instruct', 'Llama 3.1 405B Instruct', { capabilities: textCapabilities() }),
  model('meta', 'meta-llama/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct', {
    capabilities: textCapabilities(),
  }),
  model('meta', 'meta-llama/llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct', {
    capabilities: textCapabilities(),
  }),
]
