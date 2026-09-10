import type { BuiltinModelRecord } from '../types'
import { model, textCapabilities } from '../helpers'

export const AI21: readonly BuiltinModelRecord[] = [
  model('ai21', 'jamba-1.6-large', 'Jamba 1.6 Large', {
    capabilities: textCapabilities(),
  }),
  model('ai21', 'jamba-1.6-mini', 'Jamba 1.6 Mini', {
    capabilities: textCapabilities(),
  }),
  model('ai21', 'jamba-1.5-large', 'Jamba 1.5 Large', {
    capabilities: textCapabilities(),
  }),
  model('ai21', 'jamba-1.5-mini', 'Jamba 1.5 Mini', {
    capabilities: textCapabilities(),
  }),
]
