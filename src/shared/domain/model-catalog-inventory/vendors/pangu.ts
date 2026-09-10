import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities } from '../helpers'

export const PANGU: readonly BuiltinModelRecord[] = [
  model('pangu', 'openpangu-2.0-pro', 'openPangu 2.0 Pro', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      streaming: true,
    }),
    contextWindow: 512_000,
    maxOutputTokens: 128_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    verificationStatus: 'official-api',
  }),
  model('pangu', 'openpangu-2.0-flash', 'openPangu 2.0 Flash', {
    capabilities: textCapabilities({
      thinking: true,
      tools: true,
      caching: true,
      streaming: true,
    }),
    contextWindow: 512_000,
    maxOutputTokens: 128_000,
    thinkingConfig: {
      mode: 'toggle',
      defaultEnabled: true,
      parameterPath: 'thinking.type',
      enabledValue: 'enabled',
      disabledValue: 'disabled',
    },
    verificationStatus: 'official-api',
  }),
]
