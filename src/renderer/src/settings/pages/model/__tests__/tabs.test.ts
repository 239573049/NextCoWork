import { describe, expect, it } from 'vitest'
import type { Modality } from '../../../../../../shared/domain/pricing'
import { SETTINGS_PAGES } from '../../../nav'
import { isModality, MODEL_TABS, parseModelTab, type ModelTab } from '../tabs'

/**
 * 这个文件守的全是**跨文件**约定 —— 三份清单(`nav.ts` 的 sub、`tabs.ts` 的
 * `MODEL_TABS`、`pricing.ts` 的 `Modality`)必须逐字对齐。
 *
 * 对不齐的症状都是**静默**的:多一个 sub → 切过去落到 `parseModelTab` 的
 * 兜底分支,显示的是「文本生成」的内容而 Tab 高亮在别处;
 * 少一个模态 → 定价表按模态过滤时永远筛出空表。两种都不会抛错。
 */

/**
 * ★ 编译期的那一半:`Record<Modality, true>` 逼这张表跟着类型走 ——
 * `Modality` 加一个值,这个对象字面量当场少一个键,`npm run typecheck` 红。
 * 运行时的那一半在下面第一条断言里。两半缺一个,这条约定就只剩一半有牙齿。
 */
const ALL_MODALITIES: Record<Modality, true> = {
  text: true,
  image: true,
  video: true,
  speech: true,
  transcription: true
}

const modelSubs = SETTINGS_PAGES.find((p) => p.id === 'model')?.subs

describe('MODEL_TABS 与两处外部清单对齐', () => {
  it('五个模态一个不多一个不少', () => {
    expect(MODEL_TABS.filter(isModality).slice().sort()).toEqual(
      Object.keys(ALL_MODALITIES).sort()
    )
  })

  it('usage 在表里,但不是模态', () => {
    expect(MODEL_TABS).toContain('usage')
    expect(isModality('usage')).toBe(false)
    // 排末位是有意的:它是另一种视图,不和五个模态并列
    expect(MODEL_TABS[MODEL_TABS.length - 1]).toBe('usage')
  })

  it('和 nav.ts 的子 Tab 同序同值', () => {
    expect(modelSubs?.map((s) => s.id)).toEqual(MODEL_TABS)
  })

  it('每个子 Tab 都有非空中文标签', () => {
    expect(modelSubs).toHaveLength(MODEL_TABS.length)
    for (const s of modelSubs ?? []) expect(s.label.trim(), s.id).not.toBe('')
  })
})

describe('parseModelTab', () => {
  it('认识每一个合法 id', () => {
    for (const t of MODEL_TABS) expect(parseModelTab(t)).toBe(t)
  })

  /** 空串是真会传进来的:无子 Tab 的页面 `SettingsOverlay` 给的就是 `''` */
  it('空串回退到 text', () => {
    expect(parseModelTab('')).toBe('text')
  })

  it('不认识的 id 回退到 text 而不是留空', () => {
    expect(parseModelTab('pricing')).toBe('text')
    expect(parseModelTab('TEXT')).toBe('text')
  })
})

describe('isModality', () => {
  it('五个模态都为真', () => {
    for (const m of Object.keys(ALL_MODALITIES) as Modality[]) expect(isModality(m), m).toBe(true)
  })

  /** 收窄点只有它一个 —— 这里断言的是「能当 Modality 用」这件事本身 */
  it('收窄后能直接喂给收 Modality 的函数', () => {
    const take = (m: Modality): Modality => m
    const tab: ModelTab = 'image'
    expect(isModality(tab) ? take(tab) : null).toBe('image')
  })
})
