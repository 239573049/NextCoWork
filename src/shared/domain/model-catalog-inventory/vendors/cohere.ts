import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities } from '../helpers'

export const COHERE: readonly BuiltinModelRecord[] = [
  model('cohere', 'command-a-plus-05-2026', 'Command A+', {
    capabilities: textCapabilities({ tools: true, webSearch: true }),
  }),
  model('cohere', 'command-a-03-2025', 'Command A', {
    capabilities: textCapabilities({ tools: true, webSearch: true }),
  }),
  model('cohere', 'command-r-plus', 'Command R+', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('cohere', 'command-r', 'Command R', {
    capabilities: textCapabilities({ tools: true }),
  }),
  model('cohere', 'command-light', 'Command Light', {
    capabilities: textCapabilities({ tools: false }),
  }),
]
