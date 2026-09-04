import type { Modality } from '../../../../../shared/domain/pricing'

export type ModelTab = Modality | 'usage' | 'management'

export const MODEL_TABS: readonly ModelTab[] = [
  'text',
  'image',
  'video',
  'speech',
  'transcription',
  'usage'
]

export function parseModelTab(sub: string): ModelTab {
  if (sub === 'management') return 'management'
  return MODEL_TABS.find((tab) => tab === sub) ?? 'text'
}

export function isModality(tab: ModelTab): tab is Modality {
  return tab !== 'usage' && tab !== 'management'
}
