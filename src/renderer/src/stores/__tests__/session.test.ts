/**
 * ★ **运行中索引的生命周期** —— 方案 §8 那条「判断模型对不对的试金石」的落点。
 *
 * 原话:*关掉最后一个正在观看某个运行中会话的 Tab,run 依然活着,
 * 且外层工作区 Tab 上仍显示运行中角标。*
 *
 * 这条不变式在代码里是**两半**,而 bug 正好长在两半之间:
 *
 *   角标读 `runIndex`(全局,一个 Map + 一个 zustand 快照)
 *   输入框和状态行读会话 store 的 `activeRunId`(每会话一份)
 *
 * 两份状态各自都对,合起来才是「在跑」。所以这里量的从来不是单独一份 ——
 * 每个用例都**同时**断言两份,不一致就是红的。实测抓到过两个方向相反的错:
 *
 *   1. run 正常结束时只清了 `activeRunId`,索引里的条目留着 → 状态行写着
 *      「已完成」,旁边三颗橙色圆点还亮着(外层 Tab、内层 Tab、侧边栏各一颗)。
 *   2. 关工作区时把索引条目连同 store 一起删了 → run 还在主进程跑着,
 *      渲染层却已经不认识它了,事件泵按 runId 反查会话查不到,静默丢弃。
 *
 * 两个 bug 都不会让任何别的测试变红,也都不会抛异常 —— 只会在界面上显示错的东西。
 *
 * `services/agent` 整个替掉:它背后是 `window.nextcowork`,node 环境里不存在。
 * 替掉之后这个 store 就是纯状态机,正好是该在无头环境里测的部分。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../../shared/agent/event'
import type { AgentEventEnvelope } from '../../../../shared/ipc/contract'

vi.mock('../../services/agent', () => ({
  startRun: vi.fn(),
  attachRun: vi.fn(),
  abortRun: vi.fn(),
  onAgentEvent: vi.fn(() => () => {})
}))

vi.mock('../../services/app', () => ({
  getInnerTabs: vi.fn(async () => ({ tabs: [], activeTabId: null })),
  persistInnerTabs: vi.fn(),
  persistOuterTabs: vi.fn()
}))

import { abortRun, startRun } from '../../services/agent'
import type { SendOptions } from '../session'
import { adoptActiveRuns, releaseSession, sessionStore, useRunIndex } from '../session'
import { useTabsStore } from '../tabs'

const mockStartRun = vi.mocked(startRun)
const mockAbortRun = vi.mocked(abortRun)

/**
 * ★ **标注成 `SendOptions`,不要写 `as const`。** `as const` 会把 `skillIds`
 * 推成 `readonly []`,而 `RunRequest` 要的是可变数组 —— 于是这个文件里每一次
 * `send(...)` 都通不过 `tsc`,**但 vitest 全绿**(它只转译,不做类型检查)。
 * 类型标注在这儿顺带起了个断言的作用:发送参数的形状变了,这里立刻会红。
 */
const OPTS: SendOptions = {
  workspaceId: 'w1',
  depth: 0,
  mode: 'normal',
  thinking: 'auto',
  webSearch: false,
  permissionMode: 'ask',
  model: 'demo-model',
  skillIds: []
}

const runEnd: AgentEvent = { type: 'run_end', status: 'done' }
const textDelta = (text: string): AgentEvent => ({
  type: 'stream',
  delta: { type: 'text_delta', index: 0, text }
})

/** 信封的 `seq` 是**本批最后一个**事件的序号 —— 差一位就会被判成有缺口。 */
const envelope = (runId: string, events: AgentEvent[], firstSeq = 1): AgentEventEnvelope => ({
  runId,
  seq: firstSeq + events.length - 1,
  events
})

/** 当前索引里属于某会话的 run。角标就是这么算出来的(见 App.tsx)。 */
const indexed = (sessionId: string): string[] =>
  useRunIndex
    .getState()
    .filter((r) => r.sessionId === sessionId)
    .map((r) => r.runId)

/** store 是模块级单例,用例之间必须自己收干净,否则顺序一换就红。 */
const created: string[] = []
function session(id: string): ReturnType<typeof sessionStore> {
  created.push(id)
  return sessionStore(id)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStartRun.mockResolvedValue(undefined)
  mockAbortRun.mockResolvedValue(undefined)
})

afterEach(() => {
  useRunIndex.setState([], true)
  for (const id of created) {
    sessionStore(id).setState({ activeRunId: null })
    releaseSession(id)
  }
  created.length = 0
  useTabsStore.setState({ byWorkspace: {} })
})

describe('run 的两份状态必须同起同落', () => {
  it('发送:索引里出现条目,同一时刻 activeRunId 也置上了', async () => {
    const s = session('s-start')
    await s.getState().send('你好', OPTS)

    const runId = s.getState().activeRunId
    expect(runId).not.toBeNull()
    expect(indexed('s-start')).toEqual([runId])
    // 索引项要带 workspaceId —— 外层工作区 Tab 的角标按它聚合
    expect(useRunIndex.getState()[0]?.workspaceId).toBe('w1')
  })

  it('★ run 正常结束:两份一起收 —— 这就是「已完成」旁边还亮着圆点的那个 bug', async () => {
    const s = session('s-done')
    await s.getState().send('你好', OPTS)
    const runId = s.getState().activeRunId ?? ''

    s.getState().applyEnvelope(envelope(runId, [textDelta('嗨'), runEnd]))

    expect(s.getState().activeRunId).toBeNull()
    expect(indexed('s-done')).toEqual([])
  })

  it('★ 走 applyEvents 那条路(attach 补齐)也一样收', async () => {
    const s = session('s-done2')
    await s.getState().send('你好', OPTS)

    s.getState().applyEvents([runEnd])

    expect(s.getState().activeRunId).toBeNull()
    expect(indexed('s-done2')).toEqual([])
  })

  it('run 没结束就一直挂着 —— 只有 run_end 才收', async () => {
    const s = session('s-live')
    await s.getState().send('你好', OPTS)
    const runId = s.getState().activeRunId

    s.getState().applyEnvelope(envelope(runId ?? '', [textDelta('生'), textDelta('成中')]))

    expect(s.getState().activeRunId).toBe(runId)
    expect(indexed('s-live')).toEqual([runId])
  })

  it('启动就失败:抛出去之前先把两份都收掉,别留一颗永远亮着的圆点', async () => {
    mockStartRun.mockRejectedValue(new Error('上游不可达'))
    const s = session('s-fail')

    await expect(s.getState().send('你好', OPTS)).rejects.toThrow('上游不可达')

    expect(s.getState().activeRunId).toBeNull()
    expect(indexed('s-fail')).toEqual([])
  })

  it('别的 run 的信封不动本会话的状态', async () => {
    const s = session('s-other')
    await s.getState().send('你好', OPTS)
    const runId = s.getState().activeRunId

    s.getState().applyEnvelope(envelope('别人的-run', [runEnd]))

    expect(s.getState().activeRunId).toBe(runId)
    expect(indexed('s-other')).toEqual([runId])
  })
})

describe('★ 试金石:run 属于主进程,不属于任何 Tab', () => {
  it('关掉最后一个观看它的 Tab(=放掉会话 store),run 依然在索引里', async () => {
    const s = session('s-watch')
    await s.getState().send('你好', OPTS)
    const runId = s.getState().activeRunId

    // 关 Tab 不会调 releaseSession(Tab 只是引用会话),这里直接调它 ——
    // 就算调了,也必须放不掉。
    expect(releaseSession('s-watch')).toBe(false)
    expect(indexed('s-watch')).toEqual([runId])
  })

  it('关掉整个工作区:空闲会话的转录放掉,正在跑的留着', async () => {
    const busy = session('s-busy')
    const idle = session('s-idle')
    await busy.getState().send('你好', OPTS)
    idle.getState().setDraft('写了一半的草稿')

    useTabsStore.getState().hydrate('w1', {
      tabs: [
        { id: 't1', kind: 'chat', title: '在跑', ref: { sessionId: 's-busy' } },
        { id: 't2', kind: 'chat', title: '空闲', ref: { sessionId: 's-idle' } }
      ],
      activeTabId: 't1'
    })

    useTabsStore.getState().forget('w1')

    // 空闲的那个真的放掉了:再取回来是个全新的 store,草稿没了
    expect(sessionStore('s-idle').getState().draft).toBe('')
    // 在跑的那个原封不动 —— 转录、activeRunId、索引条目都还在
    expect(sessionStore('s-busy').getState().activeRunId).toBe(busy.getState().activeRunId)
    expect(indexed('s-busy')).toHaveLength(1)
  })

  it('⌘R 重载后:store 还没建,但 adoptActiveRuns 补回来的 run 同样放不掉', () => {
    adoptActiveRuns([{ runId: 'r-reload', sessionId: 's-reload', workspaceId: 'w1' }])

    // 这个会话此刻**没有 store**(懒创建),所以「在不在跑」只能问索引
    expect(releaseSession('s-reload')).toBe(false)
    expect(indexed('s-reload')).toEqual(['r-reload'])
  })

  it('空闲会话放得掉,而且放掉后重新取是干净的', () => {
    const s = session('s-free')
    s.getState().setDraft('草稿')

    expect(releaseSession('s-free')).toBe(true)
    expect(sessionStore('s-free').getState().draft).toBe('')
  })
})

describe('排队续跑', () => {
  it('生成中再发一条:进队列,不并发第二个 run', async () => {
    const s = session('s-queue')
    await s.getState().send('第一条', OPTS)
    const runId = s.getState().activeRunId

    await s.getState().send('第二条', OPTS)

    expect(mockStartRun).toHaveBeenCalledTimes(1)
    expect(s.getState().queuedInputs).toEqual(['第二条'])
    expect(s.getState().activeRunId).toBe(runId)
    expect(indexed('s-queue')).toEqual([runId])
  })

  it('★ run 结束后队列自动续跑:索引换成新 run 的条目,不是空的也不是两条', async () => {
    const s = session('s-drain')
    await s.getState().send('第一条', OPTS)
    const first = s.getState().activeRunId
    await s.getState().send('第二条', OPTS)

    s.getState().applyEvents([runEnd])
    await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(2))

    const second = s.getState().activeRunId
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(s.getState().queuedInputs).toEqual([])
    // 同一时刻只有一个 run —— 收旧的和起新的都发生了,而且只剩一条
    expect(indexed('s-drain')).toEqual([second])
  })

  it('续跑复用发送当时的档位,不读此刻的 UI 值', async () => {
    const s = session('s-opts')
    await s.getState().send('第一条', { ...OPTS, model: 'sonnet', permissionMode: 'full' })
    await s.getState().send('第二条', OPTS)

    s.getState().applyEvents([runEnd])
    await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(2))

    expect(mockStartRun.mock.calls[1]?.[0]).toMatchObject({
      input: [{ type: 'text', text: '第二条' }],
      model: 'sonnet',
      permissionMode: 'full'
    })
  })
})

describe('停止', () => {
  it('点停止只发 abort,状态等 run_end 回来才改 —— 抢先置空就看不到收尾过程', async () => {
    const s = session('s-stop')
    await s.getState().send('你好', OPTS)
    const runId = s.getState().activeRunId

    await s.getState().stop()

    expect(mockAbortRun).toHaveBeenCalledWith(runId, true)
    expect(s.getState().activeRunId).toBe(runId)
    expect(indexed('s-stop')).toEqual([runId])
  })

  it('空闲时点停止是空操作,不会误发 abort', async () => {
    const s = session('s-stop-idle')
    await s.getState().stop()
    expect(mockAbortRun).not.toHaveBeenCalled()
  })
})
