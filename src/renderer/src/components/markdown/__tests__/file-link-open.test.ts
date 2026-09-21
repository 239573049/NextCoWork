/**
 * 文件链接点下去之前的那道预检。
 *
 * 钉的是**不开那个注定报错的 Tab**:宿主说打不开时 `onOpenFile` 一次都不能被调用,
 * 而原因必须画在链接旁边 —— 「静默没反应」和「开出一个内容全是错误的 Tab」
 * 都是用户没法解释的结果。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../../i18n'
import { AgentMarkdown } from '../AgentMarkdown'
import { MarkdownProvider, type MarkdownEnvironment } from '../MarkdownProvider'

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

async function mount(environment: MarkdownEnvironment): Promise<HTMLElement> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const container = document.getElementById('root')!
  const root = createRoot(container)
  teardown = async () => {
    await act(async () => root.unmount())
    dom.window.close()
  }
  await act(async () => {
    root.render(createElement(I18nProvider, { initialLocale: 'zh-CN', children:
      createElement(MarkdownProvider, { value: environment, children:
        createElement(AgentMarkdown, { content: '[配置](src/config.ts)' }) }) }))
  })
  return container
}

/** 链接指向一个文件 —— 预检这条路只有 `kind: 'file'` 会走。 */
const fileLink = { resolveLink: (): ReturnType<NonNullable<MarkdownEnvironment['resolveLink']>> => ({ kind: 'file', path: 'src/config.ts', fragment: '' }) }

async function click(container: HTMLElement): Promise<void> {
  const anchor = container.querySelector('a')
  if (anchor === null) throw new Error('链接没有渲染')
  await act(async () => { anchor.click() })
}

describe('Markdown 文件链接 · 打开前的预检', () => {
  it('宿主说打不开时不开文件,把原因画在链接旁边', async () => {
    const onOpenFile = vi.fn()
    const container = await mount({ ...fileLink, onOpenFile, checkFile: async () => 'document.error.not-found' })
    await click(container)

    expect(onOpenFile).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('已不存在')
  })

  it('打得开时把路径与锚点原样交给宿主', async () => {
    const onOpenFile = vi.fn()
    const checkFile = vi.fn(async () => null)
    const container = await mount({ ...fileLink, onOpenFile, checkFile })
    await click(container)

    expect(checkFile).toHaveBeenCalledWith('src/config.ts')
    expect(onOpenFile).toHaveBeenCalledWith('src/config.ts', '')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  /** 缺省是**不预检**、直接开:只有宿主知道路径存不存在,而 reusable 的渲染组件不摸磁盘。 */
  it('宿主没有给出预检能力时按老样子直接开', async () => {
    const onOpenFile = vi.fn()
    const container = await mount({ ...fileLink, onOpenFile })
    await click(container)

    expect(onOpenFile).toHaveBeenCalledWith('src/config.ts', '')
  })

  it('预检自己失败时画的是「无法打开链接」,不是静默', async () => {
    const onOpenFile = vi.fn()
    const container = await mount({ ...fileLink, onOpenFile, checkFile: async () => { throw new Error('boom') } })
    await click(container)

    expect(onOpenFile).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法打开链接')
  })
})
