/**
 * 帧(WebFrameMain)先于 webContents 死掉的那个窗口期,必须**立刻** forget。
 *
 * ★ 这里的关键不是「send 抛了要接住」,而是**它根本不抛**:Electron 44 的
 * `WebContents.send` 直接转给 `mainFrame.send`,后者自己 try/catch 住
 * "Render frame was disposed" 再 `console.error` 出来。所以这些 fake 的
 * `send` 一律**不抛** —— 让它抛就等于把真实环境里唯一会出问题的那条路
 * 从测试里抹掉了(线上表现:同一个死订阅者每 flush 一次刷一屏栈)。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { runTopic, windows } from '../registry'

/** Electron 语义的替身:帧死了以后 send 静默无效,判死靠 mainFrame 自己。 */
function fakeSender(id: number, frame: unknown): {
  id: number
  isDestroyed: () => boolean
  mainFrame: unknown
  once: () => void
} {
  return {
    id,
    isDestroyed: () => false,
    get mainFrame() {
      if (frame instanceof Error) throw frame
      return frame
    },
    once: () => {}
  }
}

const envelope = (seq: number): { runId: string; seq: number; events: [] } => ({
  runId: 'r',
  seq,
  events: []
})

describe('WindowRegistry.send', () => {
  it('帧还活着:照常投递', () => {
    const send = vi.fn()
    const topic = runTopic('alive')
    windows.subscribe(topic, fakeSender(1, { isDestroyed: () => false, detached: false, send }) as never)

    windows.emitToTopic(topic, 'agent:event', envelope(1))
    windows.emitToTopic(topic, 'agent:event', envelope(2))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('帧已销毁(webContents 还没翻转)时一次都不发,并且立刻 forget', () => {
    const send = vi.fn()
    const topic = runTopic('disposed')
    windows.subscribe(topic, fakeSender(2, { isDestroyed: () => true, detached: false, send }) as never)

    windows.emitToTopic(topic, 'agent:event', envelope(1))
    expect(send).not.toHaveBeenCalled()
    // forget 掉了 —— 泵这时会看到「没人订阅」,于是整批丢弃而不是继续空转。
    expect(windows.hasSubscribers(topic)).toBe(false)
  })

  it('帧 detached(导航把它挤掉了)同样当死处理', () => {
    const send = vi.fn()
    const topic = runTopic('detached')
    windows.subscribe(topic, fakeSender(3, { isDestroyed: () => false, detached: true, send }) as never)

    windows.emitToTopic(topic, 'agent:event', envelope(1))
    expect(send).not.toHaveBeenCalled()
    expect(windows.hasSubscribers(topic)).toBe(false)
  })

  it('连 .mainFrame 这个 getter 都抛的时候也要 forget', () => {
    const topic = runTopic('getter-throws')
    const boom = new Error('Render frame was disposed before WebFrameMain could be accessed')
    windows.subscribe(topic, fakeSender(4, boom) as never)

    expect(() => windows.emitToTopic(topic, 'agent:event', envelope(1))).not.toThrow()
    expect(windows.hasSubscribers(topic)).toBe(false)
  })
})
