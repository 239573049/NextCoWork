import type { BuiltinModelRecord } from '../types'
import { model, visionCapabilities, source } from '../helpers'

export const INTERNLM: readonly BuiltinModelRecord[] = [
  model('internlm', 'intern-s2-preview-397b', 'Intern-S2-Preview-397B', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    aliases: ['intern-latest'],
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s2-preview-35b', 'Intern-S2-Preview-35B', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    aliases: ['intern-s2-preview'],
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s1-pro', 'Intern-S1-Pro', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true, webSearch: true }),
    contextWindow: 262_144,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s1', 'Intern-S1', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 32_768,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    verificationStatus: 'official-api',
  }),
  model('internlm', 'intern-s1-mini', 'Intern-S1-Mini', {
    capabilities: visionCapabilities({ tools: true, thinking: true, streaming: true }),
    contextWindow: 32_768,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking_mode',
      enabledValue: true,
      disabledValue: false,
    },
    verificationStatus: 'official-api',
  }),
  model('internlm', 'internvl3.5-241b-a28b', 'InternVL3.5-241B-A28B', {
    capabilities: visionCapabilities({ tools: false, streaming: true }),
    contextWindow: 32_768,
    aliases: ['internvl3.5-latest', 'internvl-latest'],
    verificationStatus: 'official-api',
  }),
  model('internlm', 'internvl3-38b', 'InternVL 3 38B', {
    capabilities: visionCapabilities({ tools: false }),
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    source: source('https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j'),
    verificationStatus: 'official-api',
  }),
]
