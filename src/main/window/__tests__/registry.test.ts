/**
 * `.send()` 抛出时(isDestroyed() 还没翻转,但帧已经没了)要立刻 forget,
 * 不然同一个死掉的订阅者会在它真的收到 'destroyed' 事件之前,
 * 被每一次 emit 重新抛一次同样的异常。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { runTopic, windows } from '../registry'

function fakeSender(
  id: number,
  send: () => void
): { id: number; isDestroyed: () => boolean; send: () => void; once: () => void } {
  return { id, isDestroyed: () => false, send, once: () => {} }
}

describe('WindowRegistry.send', () => {
  it('send 抛异常时把这个窗口 forget 掉,而不是下次照样再抛一次', () => {
    const throwing = vi.fn(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    })
    const sender = fakeSender(1, throwing)
    windows.subscribe(runTopic('r1'), sender as never)

    windows.emitToTopic(runTopic('r1'), 'agent:event', { runId: 'r1', seq: 1, events: [] })
    expect(throwing).toHaveBeenCalledTimes(1)

    // 已被 forget:同一个订阅者不会再挨个 emit 重新触发一次同样的抛出。
    windows.emitToTopic(runTopic('r1'), 'agent:event', { runId: 'r1', seq: 2, events: [] })
    expect(throwing).toHaveBeenCalledTimes(1)
  })
})
