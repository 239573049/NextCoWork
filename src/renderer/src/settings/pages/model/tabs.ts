import type { Modality } from '../../../../../shared/domain/pricing'

export type ModelTab = 'catalog' | 'pricing' | 'capabilities' | 'request' | 'usage' | Modality

export const MODEL_TABS: readonly ModelTab[] = [
  'catalog',
  'pricing',
  'capabilities',
  'request',
  'usage'
]

export function parseModelTab(sub: string): ModelTab {
  if (sub === 'text') return 'catalog'
  if (sub === 'image' || sub === 'video' || sub === 'speech' || sub === 'transcription') return sub
  return MODEL_TABS.find((tab) => tab === sub) ?? 'catalog'
}

export function isModality(tab: ModelTab): tab is Modality {
  return tab === 'text' || tab === 'image' || tab === 'video' || tab === 'speech' || tab === 'transcription'
}
