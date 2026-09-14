/**
 * 子代理卡片的 DOM 级回归 —— 钉的是「这张卡片不再是抽屉」。
 *
 * 这三条都抓不到的东西:纯函数测试。它们全是**某块 UI 在或不在**:
 *
 * 1. 卡片上不该再有 `aria-expanded` —— 手风琴没了。留着一个的话,读屏用户
 *    会被告知「可展开」,点下去却是换了个面板,而视觉用户根本看不出区别。
 * 2. 点整张卡片要把动作交给 `openSubagent`,而不是就地 `setState`。
 * 3. **停止按钮在不展开的情况下就能按。** 这条是这次改动的由头:
 *    它以前藏在默认折叠的面板里 —— 想掐掉一个卡住的子代理,得先点开一张
 *    从外面完全看不出异常的卡片,而会去点的人首先得怀疑它有异常。
 *
 * 样板抄 `thread-content.test.ts` 的 `renderThread`(JSDOM 手搓,没有全局
 * jsdom 环境,也没有 testing-library —— 见 `vitest.config.ts`)。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentState } from '../../../../../shared/agent/transcript'
import { I18nProvider } from '../../../i18n'
import { SubagentNode } from '../parts'
import { SubagentOpenProvider } from '../subagent-open'

vi.mock('../../../services/agent', () => ({ abortRun: vi.fn() }))
import { abortRun } from '../../../services/agent'

const CHILD_RUN = 'child-run'

function subagent(patch: Partial<SubagentState> = {}): SubagentState {
  return {
    callId: 'task-1',
    childRunId: CHILD_RUN,
    childSessionId: `parent:sub:${CHILD_RUN}`,
    status: 'running',
    description: '查配置读取处',
    subagentType: 'general-purpose',
    toolCalls: 7,
    toolErrors: 0,
    startedAt: Date.now() - 60_000,
    ...patch
  }
}

let teardown: (() => Promise<void>) | null = null

afterEach(async () => {
  await teardown?.()
  teardown = null
  vi.clearAllMocks()
})

/** 渲染一张卡片,返回容器和点开动作的探针 */
async function renderCard(state: SubagentState): Promise<{
  container: HTMLElement
  opened: SubagentState[]
}> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { nextcowork: { on: () => () => {} } })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })

  const container = document.getElementById('root')!
  const root = createRoot(container)
  const opened: SubagentState[] = []
  await act(async () => root.render(createElement(I18nProvider, {
    initialLocale: 'zh-CN',
    children: createElement(SubagentOpenProvider, {
      open: (s: SubagentState) => { opened.push(s) },
      children: createElement(SubagentNode, { summary: undefined, state })
    })
  })))
  teardown = async () => {
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
  return { container, opened }
}

const click = async (el: Element | null): Promise<void> => {
  if (el === null) throw new Error('要点的那个节点不在 —— 断言前先确认它渲染了')
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('子代理卡片 · 不是抽屉', () => {
  it('★ 整张卡片上没有任何 aria-expanded —— 手风琴已经拆掉了', async () => {
    const { container } = await renderCard(subagent())
    expect(container.querySelector('[aria-expanded]')).toBeNull()
    // 顺带钉住它确实渲染出来了,免得上面那条因为「什么都没画」而假绿
    expect(container.querySelector('[data-testid="subagent-node"]')).not.toBeNull()
    expect(container.textContent).toContain('查配置读取处')
  })

  it('★ 点卡片 = 交给 openSubagent,卡片自己不展开任何东西', async () => {
    const state = subagent()
    const { container, opened } = await renderCard(state)
    const before = container.innerHTML

    await click(container.querySelector('[data-testid="subagent-open"]'))

    expect(opened).toHaveLength(1)
    expect(opened[0]?.childSessionId).toBe(state.childSessionId)
    // ★ 点完 DOM 一个字节都没变 —— 有任何就地展开都会在这里露馅
    expect(container.innerHTML).toBe(before)
  })

  /**
   * ★★ 这条是这次改动的由头。
   *
   * 「不展开就能按」在 DOM 上的判据只有一个:停止按钮**此刻就在文档里**,
   * 而在它之前没有任何需要先点一下的东西。所以断言写成「一渲染完就查得到」,
   * 而不是「点了某个东西之后查得到」。
   */
  it('★★ 运行中时,停止按钮不展开就在那儿,按下去掐的是子 run', async () => {
    const { container } = await renderCard(subagent())
    const stop = container.querySelector('[data-testid="subagent-stop"]')
    expect(stop).not.toBeNull()

    await click(stop)
    // 第二个参数 true = 这是子 run,不要连父 run 一起收
    expect(abortRun).toHaveBeenCalledWith(CHILD_RUN, true)
  })

  it('跑完了就没有停止按钮 —— 没有可掐的东西', async () => {
    const { container } = await renderCard(subagent({ status: 'done', endedAt: Date.now() }))
    expect(container.querySelector('[data-testid="subagent-stop"]')).toBeNull()
  })

  /**
   * `childSessionId` 是随这次改动才加进 `subagent_start` 的,所以**旧转录没有**。
   * 点开会是一个空面板 —— 一张点了没反应的卡片比一张明确不能点的卡片难解释得多。
   */
  it('旧转录(没有 childSessionId)不可点', async () => {
    const { container, opened } = await renderCard(subagent({ childSessionId: undefined }))
    const open = container.querySelector('[data-testid="subagent-open"]')
    expect((open as HTMLButtonElement | null)?.disabled).toBe(true)
    await click(open)
    expect(opened).toHaveLength(0)
  })

  /**
   * ★★ 「汇报」只对后台子代理成立。
   *
   * 前台子代理的结果就是它那条 `tool_result`,同步回到主代理 —— 根本没有
   * 「回传」这一步。以前的兜底是「没写 reportStatus 且不在跑 → reported」,
   * 而前台在 `runtime.ts` 里恰恰从不写这个字段,于是**每一张跑完的前台卡片**
   * 都挂着一句「结果已汇报给主代理」,把后台专属的信号摊派给了所有人。
   */
  it('★★ 前台子代理跑完,不显示任何「已汇报」横幅', async () => {
    const { container } = await renderCard(subagent({ status: 'done', endedAt: Date.now() }))
    expect(container.textContent).not.toContain('汇报')
    expect(container.textContent).not.toContain('后台')
  })

  it('后台子代理跑完,「待汇报」和「后台」标记都在', async () => {
    const { container } = await renderCard(subagent({ status: 'done', endedAt: Date.now(), background: true }))
    expect(container.textContent).toContain('后台')
    expect(container.textContent).toContain('结果待汇报给主代理')
  })

  /** 失败原因留一行在卡片上 —— 这一条是详情整体搬走时**唯一**的例外 */
  it('出错时,原因直接写在卡片上,不必开面板', async () => {
    const { container } = await renderCard(subagent({
      status: 'error',
      endedAt: Date.now(),
      error: { code: 'provider', message: '上游 502', retryable: false, status: 502 }
    }))
    const box = container.querySelector('[data-testid="subagent-error"]')
    expect(box).not.toBeNull()
    expect(box?.textContent).toContain('502')
  })
})
