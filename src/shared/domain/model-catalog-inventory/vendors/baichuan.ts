import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities, visionCapabilities, budgetThinking, source } from '../helpers'

export const BAICHUAN: readonly BuiltinModelRecord[] = [
  model('baichuan', 'Baichuan4', 'Baichuan 4', {
    capabilities: visionCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan4-Turbo', 'Baichuan 4 Turbo', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan4-Air', 'Baichuan 4 Air', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan3-Turbo', 'Baichuan 3 Turbo', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan3-Turbo-128k', 'Baichuan 3 Turbo 128K', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 131_072,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan2-Turbo', 'Baichuan 2 Turbo', {
    capabilities: textCapabilities(),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-M3-Plus', 'Baichuan M3 Plus', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-M3', 'Baichuan M3', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-M2-Plus', 'Baichuan M2 Plus', {
    capabilities: textCapabilities({ tools: false }),
    contextWindow: 32_768,
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
  model('baichuan', 'Baichuan-Omni-1.5', 'Baichuan Omni 1.5', {
    capabilities: visionCapabilities({ tools: false, audioInput: true }),
  }),
  model('baichuan', 'Baichuan-M2', 'Baichuan M2', {
    capabilities: textCapabilities({ tools: false, thinking: true }),
    contextWindow: 32_768,
    thinkingConfig: budgetThinking('thinking_budget', 16_384),
    source: source('https://platform.baichuan-ai.com/prices'),
    verificationStatus: 'official-api',
  }),
]
