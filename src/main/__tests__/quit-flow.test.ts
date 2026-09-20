/**
 * 退出流程的两段式 —— 以及它换掉的那个僵尸进程。
 *
 * 原来的实现在 `before-quit` 里一口气做完了所有事:销毁托盘、停服务、**封库**,
 * 最后 `app.quit()`。而那次 `app.quit()` 会被渲染层的 `beforeunload` 整个取消
 * (实测:窗口拒绝 unload 时进程 3 秒后仍然活着)。于是进程停在
 * 「`isQuitting` 为 true(所有唤回路径直接 return)、托盘已销毁、库已封」的
 * 状态里 —— 用户看到的是「退出之后一直显示打开,点 Dock 没反应」,只能强杀。
 *
 * 这几条断言分别钉住那三个症状与两条兜底,顺序就是它们的因果顺序:
 *
 *  1. 渲染层顶住 unload → **整次退出作废**:托盘还在、库没封、后台服务还在跑
 *     (所以点 Dock 还能真的把界面唤回来)。
 *  2. 作废之后再请求一次退出 → 照常收尾一次(用户已经在对话框里选完了)。
 *  3. 收尾只做一次:`sealDatabase` 之后再有人回头碰库就是 `DatabaseClosedError`。
 *  4. 渲染层卡死(不顶也不放)→ 到点强制销毁窗口并收尾,进程一定走得掉。
 *  5. 收尾自己抛错 → 进程仍然退出,不留半退出状态。
 *
 * 同时也是「非 macOS 上 `window-all-closed` 不能顺手收尾」的回归网:那个平台上
 * 窗口关完 ≠ 用户要退出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuitFlow, type QuitWindow } from '../quit-flow'

/** 既能当「顶住 unload 的窗口」也能当「乖乖关掉的窗口」用的假窗口。 */
class FakeWindow implements QuitWindow {
  destroyed = false
  closeCalls = 0
  destroyCalls = 0
  /** true = 这个窗口的 close 会被渲染层顶住,于是永远不销毁(退出于是卡住)。 */
  constructor(private readonly blocks: boolean) {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.closeCalls += 1
    if (!this.blocks) this.destroyed = true
  }

  destroy(): void {
    this.destroyCalls += 1
    this.destroyed = true
  }
}

interface Harness {
  flow: QuitFlow
  events: string[]
  closedWindows: () => number
  resolveDrain: () => void
}

function makeHarness(options: {
  windows: FakeWindow[]
  /** 收尾时抛错,用来验证「任何一步失败都必须退出」。 */
  sealThrows?: boolean
  stopThrows?: boolean
  quitThrows?: boolean
  closeDeadlineMs?: number
  asyncDeadlineMs?: number
}): Harness {
  const events: string[] = []
  let releaseDrain: (() => void) | null = null
  const drain = new Promise<void>((resolve) => {
    releaseDrain = resolve
  })
  const flow = new QuitFlow({
    windows: () => options.windows,
    stopBackground: () => {
      events.push('stopBackground')
      if (options.stopThrows === true) throw new Error('stop failed')
    },
    drainAsync: () => drain.then(() => events.push('drainAsync')),
    destroyTray: () => events.push('destroyTray'),
    sealDatabase: () => {
      events.push('sealDatabase')
      if (options.sealThrows === true) throw new Error('seal failed')
    },
    quit: () => {
      events.push('quit')
      if (options.quitThrows === true) throw new Error('quit failed')
    },
    exit: (code) => events.push(`exit:${code}`),
    ...(options.closeDeadlineMs === undefined ? {} : { closeDeadlineMs: options.closeDeadlineMs }),
    ...(options.asyncDeadlineMs === undefined ? {} : { asyncDeadlineMs: options.asyncDeadlineMs })
  })
  return {
    flow,
    events,
    closedWindows: () => options.windows.filter((win) => win.destroyed).length,
    resolveDrain: () => releaseDrain?.()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/**
 * 跑完 `finish()` 里那条 `drainAsync → catch → then` 的微任务链。
 * 固定次数而不是 `await` 具体几层 —— 链的层数变了这里不该跟着改。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('用户在有未保存的文件时退出', () => {
  it('keeps tray, database and background services intact when the renderer blocks the unload', () => {
    const blocked = new FakeWindow(true)
    const harness = makeHarness({ windows: [blocked] })

    harness.flow.begin()
    // 渲染层顶住了这次 unload —— 主进程侧收到 will-prevent-unload,退出作废。
    harness.flow.veto()

    expect(blocked.closeCalls).toBe(1)
    expect(blocked.destroyed).toBe(false)
    expect(harness.events).toEqual([])
    expect(harness.flow.inProgress).toBe(false)
    expect(harness.flow.done).toBe(false)
  })

  it('quits on the second request once the user has chosen in the dialog', async () => {
    const blocked = new FakeWindow(true)
    const harness = makeHarness({ windows: [blocked] })

    harness.flow.begin()
    harness.flow.veto()

    // 用户在对话框里选了「丢弃 / 保存全部」,渲染层重发一次退出。
    harness.flow.begin()
    // 这一轮里渲染层不再顶,窗口真的关掉 —— 主进程侧就是 window-all-closed。
    blocked.destroyed = true
    harness.flow.windowsClosed()

    expect(harness.events).toEqual(['destroyTray', 'stopBackground'])
    harness.resolveDrain()
    await settle()
    expect(harness.events).toEqual(['destroyTray', 'stopBackground', 'drainAsync', 'sealDatabase', 'quit'])
  })

  it('seals the database exactly once even if windows keep closing afterwards', async () => {
    const window = new FakeWindow(false)
    const harness = makeHarness({ windows: [window] })

    harness.flow.begin()
    harness.flow.windowsClosed()
    harness.resolveDrain()
    await settle()
    // 收尾之后任何回流都不许再碰库:sealDatabase 之后再写就是 DatabaseClosedError。
    harness.flow.windowsClosed()
    harness.flow.begin()

    expect(harness.events.filter((event) => event === 'sealDatabase')).toHaveLength(1)
    expect(harness.events.filter((event) => event === 'quit')).toHaveLength(1)
    expect(harness.flow.done).toBe(true)
  })
})

describe('渲染层把自己卡住', () => {
  it('force-destroys the windows once the close deadline passes', () => {
    const stuck = new FakeWindow(true)
    const harness = makeHarness({ windows: [stuck], closeDeadlineMs: 6000 })

    harness.flow.begin()
    expect(stuck.destroyCalls).toBe(0)

    vi.advanceTimersByTime(6000)

    expect(stuck.destroyCalls).toBe(1)
    expect(stuck.destroyed).toBe(true)
    expect(harness.events).toEqual(['destroyTray', 'stopBackground'])
  })

  it('cancels the close deadline so a vetoed quit does not destroy the window later', () => {
    const window = new FakeWindow(true)
    const harness = makeHarness({ windows: [window], closeDeadlineMs: 6000 })

    harness.flow.begin()
    harness.flow.veto()
    vi.advanceTimersByTime(60000)
    window.destroyed = true

    expect(harness.events).toEqual([])
  })

  it('quits anyway when the async drain never settles', async () => {
    const window = new FakeWindow(false)
    const harness = makeHarness({ windows: [window], asyncDeadlineMs: 6000 })

    harness.flow.begin()
    harness.flow.windowsClosed()
    expect(harness.events).toEqual(['destroyTray', 'stopBackground'])

    vi.advanceTimersByTime(6000)
    expect(harness.events).toEqual(['destroyTray', 'stopBackground', 'sealDatabase', 'quit'])
  })

  it('does not seal twice when the drain lands after the timeout already fired', async () => {
    const window = new FakeWindow(false)
    const harness = makeHarness({ windows: [window], asyncDeadlineMs: 6000 })

    harness.flow.begin()
    harness.flow.windowsClosed()
    vi.advanceTimersByTime(6000)
    // 超时那一发已经把库封了、也已经 app.quit();drain 现在才落地。
    harness.resolveDrain()
    await settle()

    expect(harness.events.filter((event) => event === 'sealDatabase')).toHaveLength(1)
    expect(harness.events.filter((event) => event === 'quit')).toHaveLength(1)
  })
})

describe('收尾里的失败不许留在半退出状态', () => {
  it('exits with a failure code when app.quit() itself throws', async () => {
    const window = new FakeWindow(false)
    const harness = makeHarness({ windows: [window], quitThrows: true })

    harness.flow.begin()
    harness.flow.windowsClosed()
    harness.resolveDrain()
    await settle()

    // quit 抛错 = 真的退不掉了,只剩 app.exit 一条路 —— 不许留在半退出状态。
    expect(harness.events).toContain('quit')
    expect(harness.events).toContain('exit:1')
  })

  it('still quits when stopping background services throws', async () => {
    const window = new FakeWindow(false)
    const harness = makeHarness({ windows: [window], stopThrows: true })

    harness.flow.begin()
    harness.flow.windowsClosed()
    harness.resolveDrain()
    await settle()

    expect(harness.events).toEqual(['destroyTray', 'stopBackground', 'drainAsync', 'sealDatabase', 'quit'])
  })

  it('still quits when sealing the database throws', async () => {
    const window = new FakeWindow(false)
    const harness = makeHarness({ windows: [window], sealThrows: true })

    harness.flow.begin()
    harness.flow.windowsClosed()
    harness.resolveDrain()
    await settle()

    expect(harness.events).toEqual(['destroyTray', 'stopBackground', 'drainAsync', 'sealDatabase', 'quit'])
    expect(harness.events).not.toContain('exit:1')
  })
})

describe('没有窗口可关时', () => {
  it('finishes immediately instead of waiting for a window-all-closed that cannot come', async () => {
    const harness = makeHarness({ windows: [] })

    harness.flow.begin()
    harness.resolveDrain()
    await settle()

    expect(harness.events).toEqual(['destroyTray', 'stopBackground', 'drainAsync', 'sealDatabase', 'quit'])
  })
})

describe('不理会无关的窗口事件', () => {
  it('ignores window-all-closed when no quit is in progress, so mac close-to-hide is not a quit', () => {
    // 关掉最后一个窗口(关窗按钮把它藏起来 / 插件宿主窗销毁)不该顺手退出。
    const harness = makeHarness({ windows: [] })

    harness.flow.windowsClosed()

    expect(harness.flow.done).toBe(false)
    expect(harness.events).toEqual([])
  })
})
