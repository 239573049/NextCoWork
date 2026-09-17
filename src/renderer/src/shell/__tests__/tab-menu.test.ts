/**
 * `+` 菜单与功能页标题的 **i18n 回归**。
 *
 * 这一组钉的是计划 §7.1 那个 bug:`INNER_TAB_MENU` 的 label 是硬编码中文,
 * 渲染处直接铺出去 —— 切到 `en-US` 菜单还是中文,而且**不会有任何报错**。
 * 改成 key 之后,漏翻的那一条会在这里当场挂掉,而不是等着某个用户截图反馈。
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TAB_MENU,
  FEATURE_LABEL_KEY,
  tabMenuForPane,
  type FeatureKind
} from '../../../../shared/domain/tab'
import { MENU_ICON_NAMES } from '../../../../shared/plugin/contribution'
import { messagesFor } from '../../i18n'
import { MENU_ICON } from '../icons'

const LOCALES = ['zh-CN', 'en-US'] as const

describe('+ 菜单 · i18n', () => {
  it('★ 每一项的 titleKey 在两种语言里都有料', () => {
    for (const locale of LOCALES) {
      const messages = messagesFor(locale)
      for (const item of BUILTIN_TAB_MENU) {
        expect(messages[item.titleKey], `${locale} 缺 ${item.titleKey}`).toBeDefined()
      }
    }
  })

  it('★ 菜单项里没有裸文案 —— titleKey 必须长得像 key,不像句子', () => {
    for (const item of BUILTIN_TAB_MENU) {
      expect(item.titleKey, item.id).toMatch(/^[a-z][A-Za-z0-9.]*$/)
    }
  })

  it('★ 切到英文之后真的是英文', () => {
    const en = messagesFor('en-US')
    const zh = messagesFor('zh-CN')
    for (const item of BUILTIN_TAB_MENU) {
      // 两种语言给出不同的串 = 这一项真的被翻译过,而不是两边填了同一句中文
      expect(en[item.titleKey], item.id).not.toBe(zh[item.titleKey])
    }
  })

  it('功能页标题同样是 key,两种语言都有料', () => {
    for (const locale of LOCALES) {
      const messages = messagesFor(locale)
      for (const [feature, key] of Object.entries(FEATURE_LABEL_KEY) as [FeatureKind, string][]) {
        expect(messages[key], `${locale} 缺 ${feature}`).toBeDefined()
      }
    }
  })

  it('★ 图标名全在白名单里,而且渲染层那张 Record 一个都不缺', () => {
    for (const item of BUILTIN_TAB_MENU) {
      expect(MENU_ICON_NAMES, item.id).toContain(item.icon)
      expect(MENU_ICON[item.icon], item.id).toBeDefined()
    }
    // 两张表必须逐项对上 —— 少一个的症状是「插件的菜单项没有图标」,不报错
    for (const name of MENU_ICON_NAMES) expect(MENU_ICON[name], name).toBeDefined()
  })
})

describe('+ 菜单 · 分格', () => {
  it('主区不出「工作区文件」与「文件预览」', () => {
    const ids = tabMenuForPane(BUILTIN_TAB_MENU, 'main').map((item) => item.id)
    expect(ids).not.toContain('builtin.files')
    expect(ids).not.toContain('builtin.preview')
  })

  it('★ 底部有文件预览但没有工作区文件,右侧两个都有 —— 和改造前逐项一致', () => {
    const bottom = tabMenuForPane(BUILTIN_TAB_MENU, 'bottom').map((item) => item.id)
    const right = tabMenuForPane(BUILTIN_TAB_MENU, 'right').map((item) => item.id)
    expect(bottom).toContain('builtin.preview')
    expect(bottom).not.toContain('builtin.files')
    expect(right).toContain('builtin.files')
    expect(right).toContain('builtin.preview')
  })

  it('★ 三格的创建类项目完全一致,顺序也一致', () => {
    const creates = (pane: 'main' | 'bottom' | 'right'): string[] =>
      tabMenuForPane(BUILTIN_TAB_MENU, pane).filter((item) => item.group === 'create').map((item) => item.id)
    expect(creates('main')).toEqual(['builtin.chat', 'builtin.draw', 'builtin.doc'])
    expect(creates('bottom')).toEqual(creates('main'))
    expect(creates('right')).toEqual(creates('main'))
  })

  it('★ 分隔线落在 create|tools 边界 —— 截图里那条分隔的位置没变', () => {
    const main = tabMenuForPane(BUILTIN_TAB_MENU, 'main')
    const boundary = main.findIndex((item) => item.group === 'tools')
    expect(main[boundary - 1]?.id).toBe('builtin.doc')
    expect(main[boundary]?.id).toBe('builtin.terminal')
  })
})
