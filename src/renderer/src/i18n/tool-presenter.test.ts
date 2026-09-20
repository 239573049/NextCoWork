import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PRESENTER_COPY_KEYS,
  presenterOf,
  registeredToolIds
} from '../../../shared/domain/tool-presenter'
import { I18nProvider, messagesFor, translate, useI18n } from './index'

/**
 * 这一组守的是「工具卡片文案」注入链的两端:
 * 1. 两张表确实被 spread 进了 ZH/EN —— 漏 spread(尤其英文那份)不会编译报错,
 *    表现为英文界面下每张工具卡片都显示 key 本身;
 * 2. `./index` 模块加载时确实把 translate 注入了注册表 —— 漏接的话,
 *    表再全也轮不到它被查,全部卡片回显示 key。
 * 两种失败都不崩,靠盯屏幕才能发现,所以在这里钉死。
 */
describe('内置工具卡片文案', () => {
  it('两种语言的合并表都覆盖全部 presenter key,且不回显 key 本身', () => {
    for (const key of PRESENTER_COPY_KEYS) {
      expect(messagesFor('zh-CN')[key], key).toBeDefined()
      expect(messagesFor('en-US')[key], key).toBeDefined()
    }
  })

  it('★ 接线已生效:presenter 的标题走 translate(漏注入时这里会拿到 key 原文)', () => {
    // 断言全用 translate 作对照而不是写死中文 —— 与当前 locale 解耦,单独跑这一条也成立
    expect(presenterOf('Read').title({ file_path: '/w/src/main/index.ts' })).toBe(
      translate('chat.tool.title.read', { target: 'index.ts' })
    )
    // 半截 JSON:target 为空串 → 文案表退化成「动词…」,而不是残句
    expect(presenterOf('Read').title('{"file_p')).toBe(translate('chat.tool.title.read', { target: '' }))
    expect(
      presenterOf('Bash').summary?.({}, { content: 'Command exited with code 127.\nnot found' })
    ).toBe(translate('chat.tool.summary.exitCode', { code: '127' }))
  })

  it('★ 切语言不需要重建 presenter —— 注入的是 translate 本体,渲染时现查 locale', () => {
    function Title(): string {
      return presenterOf('Read').title({ file_path: '/a/b/c.ts' })
    }
    const zh = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'zh-CN', children: createElement(Title) }))
    const en = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en-US', children: createElement(Title) }))
    expect(zh).toContain('读取 c.ts')
    expect(en).toContain('Reading c.ts')
  })

  it('★ 任何内置工具的标题/摘要都不把 {param} 漏到界面上', () => {
    // 覆盖两条最易漏参的路径:空入参(流式前)和典型入参(流式中)
    const typical: Record<string, unknown> = {
      file_path: '/a/b.ts',
      path: '/a',
      pattern: 'p',
      command: 'ls',
      description: '列目录',
      bash_id: 'bash_1',
      shell_id: 'bash_1',
      url: 'https://example.com/x',
      query: 'q',
      name: 'n',
      subagent_type: 'general',
      todos: [{ status: 'completed', content: 'c' }],
      schedule: { kind: 'weekly', weekdays: [1, 3], time: '09:00' }
    }
    for (const id of registeredToolIds()) {
      const p = presenterOf(id)
      for (const input of [{}, typical]) {
        expect(p.title(input), id).not.toMatch(/\{\w+\}/)
        const summary = p.summary?.(input, { content: 'Command exited with code 1.\nline' })
        if (summary !== undefined) expect(summary, id).not.toMatch(/\{\w+\}/)
      }
    }
  })

  it('英文表对每周规则渲染出星期名,中文表渲染出「周几」', () => {
    function Weekly(): string {
      return useI18n().t('chat.tool.summary.scheduleWeekly', { days: '135', time: '09:00' })
    }
    const zh = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'zh-CN', children: createElement(Weekly) }))
    const en = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en-US', children: createElement(Weekly) }))
    expect(zh).toContain('周一三五 09:00')
    expect(en).toContain('Mon, Wed, Fri 09:00')
  })
})
