import type { Modality } from '../../../../../shared/domain/pricing'

export type ModelTab = Modality | 'management'

/**
 * ★ 只有五个模态。「使用统计」曾经排在末位,现在是设置侧栏里的独立一页
 * (`nav.ts` 的 `usage`)—— 它不写任何设置,只读历史账,和「按模态选模型」
 * 不是同一类事。「模型管理」是 `ModelTab` 但不在这张表里:它由侧边的
 * 「管理」入口进,不占模态切换器的位置。
 */
export const MODEL_TABS: readonly ModelTab[] = ['text', 'image', 'video', 'speech', 'transcription']

export function parseModelTab(sub: string): ModelTab {
  if (sub === 'management') return 'management'
  return MODEL_TABS.find((tab) => tab === sub) ?? 'text'
}

export function isModality(tab: ModelTab): tab is Modality {
  return tab !== 'management'
}
