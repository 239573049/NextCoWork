/**
 * 模型页顶部那条 Tab 的取值。
 *
 * ★ **抽成 `.ts` 是为了能被执行。** `vitest.config.ts` 是 node 环境、
 * `include` 只收 `.test.ts`,写在 `.tsx` 里的判断一行都不会跑;
 * 而这里要守的恰好是一条**跨文件**约定 —— `nav.ts` 里那六个 sub id
 * 必须和下面这张表逐字相同,否则切到某个 Tab 会落到一个谁也没处理的分支。
 */
import type { Modality } from '../../../../../shared/domain/pricing'

/**
 * ★ `usage` 是并进来的第六项,**不是第六种模态**。
 *
 * `shared/domain/pricing.ts` 的 `Modality` 刻意不含它,理由写在那边:
 * 「按模态过滤定价表」这类地方要是能拿到一个 `'usage'`,就得处处特判。
 * 所以联合只在**这一层**发生,`isModality` 是唯一的收窄点。
 */
export type ModelTab = Modality | 'usage'

/** 顺序即 Tab 顺序。`usage` 排末位:它是视图,不和五个模态并列 */
export const MODEL_TABS: readonly ModelTab[] = [
  'text',
  'image',
  'video',
  'speech',
  'transcription',
  'usage'
]

export function isModality(tab: ModelTab): tab is Modality {
  return tab !== 'usage'
}

/**
 * 认不出的 sub 回退到 `text`,**不返回 undefined**。
 *
 * 空串是真会发生的:`SettingsOverlay` 给无子 Tab 的页面传的就是 `''`,
 * 而这一页刚长出子 Tab —— 万一哪次导航没带上 sub,回退到「文本生成」
 * 只是少切了一下,返回 undefined 则会让整页空白,后者更难查。
 */
export function parseModelTab(sub: string): ModelTab {
  return MODEL_TABS.find((t) => t === sub) ?? 'text'
}
