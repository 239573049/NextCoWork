import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentError } from '../../../shared/agent/error'
import { I18nProvider, messagesFor, useI18n } from './index'
import {
  MAX_PLUGIN_MESSAGES,
  PluginMessageError,
  clearPluginMessages,
  registerPluginMessages,
  unregisterPluginMessages
} from './plugin-messages'
import { agentErrorText } from './agent'
import { whimsyEn, whimsyZh } from './whimsy'

describe('renderer i18n catalog', () => {
  it('has a complete English catalog for every Chinese key', () => {
    const zh = messagesFor('zh-CN')
    const en = messagesFor('en-US')
    for (const key of Object.keys(zh)) expect(en[key], key).toBeDefined()
  })

  it('keeps locale-independent language names readable', () => {
    expect(messagesFor('en-US')['locale.name.zhCN']).toBe('简体中文')
    expect(messagesFor('en-US')['locale.name.enUS']).toBe('English')
  })

  it.each(['zh-CN', 'en-US'] as const)('localizes attachment failures and their diagnostic parameters in %s', (locale) => {
    const keys = Object.keys(messagesFor('zh-CN')).filter((key) => key.startsWith('attachment.error.'))
    expect(keys.length).toBeGreaterThan(0)
    for (const messageKey of keys) {
      const error: AgentError = {
        code: 'provider', message: 'internal fallback', retryable: false, messageKey,
        messageParams: { name: 'photo.png', mime: 'image/bmp', limit: 32, code: 'EACCES' }
      }
      function ErrorCopy(): string { return agentErrorText(error, useI18n().t) }
      const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: createElement(ErrorCopy) }))
      expect(html).not.toContain('internal fallback')
      expect(html).not.toContain(messageKey)
      expect(html).not.toMatch(/\{\w+\}/)
      if (messageKey === 'attachment.error.unreadable') {
        expect(html).toContain('photo.png')
        expect(html).toContain('EACCES')
        expect(html).toContain(locale === 'zh-CN' ? '无法读取图片附件' : 'Cannot read image attachment')
      }
    }
  })

  it.each(['zh-CN', 'en-US'] as const)('localizes mandatory-cache errors in %s without offering to disable caching', (locale) => {
    for (const messageKey of ['agent.error.cacheUnsupported', 'agent.error.cacheUnsupportedUnnamed'] as const) {
      const error: AgentError = {
        code: 'cache_unsupported', message: 'raw fallback', retryable: false, messageKey,
        messageParams: { provider: 'Relay A', ttl: '5m', detail: 'cache_control is not supported' }
      }
      function ErrorCopy(): string {
        return agentErrorText(error, useI18n().t)
      }
      const html = renderToStaticMarkup(createElement(I18nProvider, {
        initialLocale: locale, children: createElement(ErrorCopy)
      }))
      expect(html).toContain(locale === 'zh-CN' ? '缓存标记为必需' : 'Cache markers are required')
      expect(html).toContain('5m')
      expect(html).toContain('cache_control is not supported')
      if (messageKey === 'agent.error.cacheUnsupported') expect(html).toContain('Relay A')
      expect(html).not.toContain('raw fallback')
      expect(html).not.toContain(locale === 'zh-CN' ? '关闭' : 'disable')
    }
  })
})

/**
 * 轮换词**不进** Messages 表,也就绕开了上面那条键一致性校验 —— 它们是一串
 * 可以随便增删的料。这一组守的是那份自由的边界:每个分组都得有料(少一个分组
 * 就是那一档永远显示 undefined),而且每条都得短 —— 这句话右边紧跟着用量读数,
 * 词一长后面整排就跟着左右抖,而这种抖动在截图里根本看不出是文案造成的。
 */
describe('whimsy 轮换词', () => {
  const ZH_MAX = 6
  const EN_MAX = 14

  it('每个分组两种语言都有料', () => {
    for (const phase of Object.keys(whimsyZh) as Array<keyof typeof whimsyZh>) {
      expect(whimsyZh[phase].length, phase).toBeGreaterThan(0)
      expect(whimsyEn[phase].length, phase).toBeGreaterThan(0)
    }
  })

  it('长度压在预算内,免得状态行右边那串读数跟着抖', () => {
    for (const [phase, words] of Object.entries(whimsyZh)) {
      for (const word of words) expect([...word].length, `${phase}: ${word}`).toBeLessThanOrEqual(ZH_MAX)
    }
    for (const [phase, words] of Object.entries(whimsyEn)) {
      for (const word of words) expect([...word].length, `${phase}: ${word}`).toBeLessThanOrEqual(EN_MAX)
    }
  })

  it('同一分组内不重复 —— 重复项会让轮换看起来像卡住了', () => {
    for (const [phase, words] of [...Object.entries(whimsyZh), ...Object.entries(whimsyEn)]) {
      expect(new Set(words).size, phase).toBe(words.length)
    }
  })
})

/**
 * 运行期注册进来的插件文案。
 *
 * 这一组守的是那个口子的**边界**:开得太大等于把整套 UI 文案交给插件改写,
 * 开得太小等于插件只能往 JSX 里塞裸字符串(项目 AGENTS.md 的第一条)。
 */
describe('插件文案 · 运行期注册', () => {
  const dict = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`plugin.acme.demo.k${String(i)}`, `v${String(i)}`]))

  afterEach(() => {
    // 注册表是模块级的 —— 不清的话,下一个文件里的测试会看见这里装的东西
    clearPluginMessages()
  })

  it('注册之后两种语言各拿各的', () => {
    registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.title': '示意图' })
    registerPluginMessages('acme.demo', 'en-US', { 'plugin.acme.demo.title': 'Diagram' })
    expect(messagesFor('zh-CN')['plugin.acme.demo.title']).toBe('示意图')
    expect(messagesFor('en-US')['plugin.acme.demo.title']).toBe('Diagram')
  })

  it('★ 内置 key 改写不了 —— 否则一个插件就能把全应用的按钮换成任意文字', () => {
    expect(() =>
      registerPluginMessages('acme.demo', 'zh-CN', { 'common.confirm': '点这里' })
    ).toThrow(PluginMessageError)
    expect(messagesFor('zh-CN')['common.confirm']).not.toBe('点这里')
  })

  it('★ 一条不合规就整份拒绝,不是部分接受', () => {
    expect(() =>
      registerPluginMessages('acme.demo', 'zh-CN', {
        'plugin.acme.demo.ok': '好',
        'other.key': '坏'
      })
    ).toThrow(PluginMessageError)
    expect(messagesFor('zh-CN')['plugin.acme.demo.ok']).toBeUndefined()
  })

  it('别人家的前缀也注册不了', () => {
    expect(() =>
      registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.evil.other.title': '冒名' })
    ).toThrow(PluginMessageError)
  })

  it('条数与单条长度都有上限', () => {
    expect(() => registerPluginMessages('acme.demo', 'zh-CN', dict(MAX_PLUGIN_MESSAGES + 1))).toThrow(PluginMessageError)
    expect(() =>
      registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.long': 'x'.repeat(2000) })
    ).toThrow(PluginMessageError)
  })

  it('★ 卸载要卸干净 —— 留一条就意味着功能没了文案还在', () => {
    registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.title': '示意图' })
    registerPluginMessages('acme.demo', 'en-US', { 'plugin.acme.demo.title': 'Diagram' })
    unregisterPluginMessages('acme.demo')
    expect(messagesFor('zh-CN')['plugin.acme.demo.title']).toBeUndefined()
    expect(messagesFor('en-US')['plugin.acme.demo.title']).toBeUndefined()
  })

  it('合并视图跟着注册走,不会返回上一份缓存', () => {
    registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.title': '一' })
    expect(messagesFor('zh-CN')['plugin.acme.demo.title']).toBe('一')
    registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.title': '二' })
    expect(messagesFor('zh-CN')['plugin.acme.demo.title']).toBe('二')
  })

  it('★ 装完之后内置 catalog 一个 key 都没少', () => {
    const before = Object.keys(messagesFor('zh-CN')).length
    registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.title': '示意图' })
    expect(Object.keys(messagesFor('zh-CN')).length).toBe(before + 1)
  })

  it('t() 读得到插件文案,只有一种语言时回落到中文那份', () => {
    registerPluginMessages('acme.demo', 'zh-CN', { 'plugin.acme.demo.title': '示意图' })
    function Copy(): string {
      return useI18n().t('plugin.acme.demo.title')
    }
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, { initialLocale: locale, children: createElement(Copy) })
      )
      expect(html).toContain('示意图')
    }
  })

  it('缺 key 时显示 key 本身,而不是把渲染层打崩', () => {
    function Copy(): string {
      return useI18n().t('plugin.acme.demo.missing')
    }
    const html = renderToStaticMarkup(
      createElement(I18nProvider, { initialLocale: 'zh-CN', children: createElement(Copy) })
    )
    expect(html).toContain('plugin.acme.demo.missing')
  })
})
