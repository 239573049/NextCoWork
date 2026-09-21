/**
 * 「题面在模型还在写的时候就能读到,但点不动」这条规则的回归。
 *
 * 两头都会静默坏掉:
 * 1. 卡片不自动展开 —— 题面确实渲染了,但藏在折叠里,等于没做;
 * 2. 待决面板出来之后这张预览还展着 —— 同屏两份一样的题,
 *    而只有下面那份能提交,用户点上面那份不会有任何反应。
 * 两种都不报错,所以钉在这里。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { ToolCallCard } from '../parts'

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

describe('ToolCallCard · AskUserQuestion 的流式预览', () => {
  it('参数还在流时自动展开只读题面,工具一开跑就收起来', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
    Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    // Radix 的单选组在 effect 里摸 HTMLFormElement(它要找外层 form)——
    // jsdom 的这个全局不在 vi.stubGlobal('window') 的覆盖范围里,漏补就是一句
    // 「HTMLFormElement is not defined」,而报错栈全在 node_modules 里。
    vi.stubGlobal('HTMLFormElement', dom.window.HTMLFormElement)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })

    const container = document.getElementById('root')!
    const root = createRoot(container)
    const render = async (input: unknown, call?: ToolCallState): Promise<void> => {
      await act(async () => root.render(createElement(I18nProvider, {
        initialLocale: 'zh-CN',
        children: createElement(ToolCallCard, { call, name: 'AskUserQuestion', input })
      })))
    }
    const expanded = (): string | null =>
      container.querySelector('[data-testid="tool-call"] button')?.getAttribute('aria-expanded') ?? null
    teardown = async () => {
      await act(async () => root.unmount())
      dom.window.close()
    }

    // 参数写到一半:题面已经能读,而且不用点就看得见
    await render('{"questions":[{"header":"范围","question":"改哪里","options":[{"label":"只改渲染层"')
    expect(expanded()).toBe('true')
    const preview = (): Element | null => container.querySelector('[data-testid="interaction-preview"]')
    expect(preview()?.textContent).toContain('改哪里')
    expect(preview()?.textContent).toContain('只改渲染层')
    // ★ 用的必须是待决卡那张壳子本身(同一个 CardShell)—— 标题一致是最直接的证据
    expect(preview()?.querySelector('[data-testid="agent-interaction-preview"]')).not.toBeNull()
    expect(preview()?.textContent).toContain('需要你的回答')
    /*
      ★ 预览**不带** `data-interaction-kind`:QA 脚本按它找可作答的卡并往里填字
      (`scripts/agent-protocol-qa.mjs`),而预览在 DOM 里排在真卡前面 ——
      带上它就会被 querySelector 抢先命中一个 disabled 的输入框。
    */
    expect(container.querySelector('[data-interaction-kind]')).toBeNull()

    // ★ 每一行都得是 disabled:这里没有 interaction.id,点下去无处可交
    const rows = [...container.querySelectorAll('[data-row-value]')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.hasAttribute('disabled'))).toBe(true)

    // 第二道题流出来:切换条跟着出现,否则后面几道在写完之前根本看不见
    await render('{"questions":[{"header":"范围","question":"改哪里"},{"header":"时机","question":"何时提交"')
    expect(preview()?.textContent).toContain('时机')

    // tool_start 到了 —— 可作答的那张卡此刻出现在下面,预览必须让位
    await render('{"questions":[{"header":"范围","question":"改哪里"}]}', {
      callId: 'call-1',
      name: 'AskUserQuestion',
      input: { questions: [{ header: '范围', question: '改哪里', options: [], multiSelect: false, allowFreeform: true }] },
      status: 'running'
    })
    expect(expanded()).toBe('false')
  })
})
