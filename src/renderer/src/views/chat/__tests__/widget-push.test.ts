/**
 * 推送节流器的单测。
 *
 * 这几条规则是"长 widget 生成时会不会越来越卡"的全部判据 —— 而它们
 * **只在流式路径上成立**,靠盯屏幕看不出来(生成快的时候什么都正常)。
 * 所以用假时钟把它们逐条钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUSH_INTERVAL_MS, createPushScheduler } from '../widget-push'

let sent: Array<{ html: string; final: boolean }>

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
})

afterEach(() => {
  vi.useRealTimers()
})

function scheduler(): ReturnType<typeof createPushScheduler> {
  return createPushScheduler((html, final) => sent.push({ html, final }))
}

describe('createPushScheduler', () => {
  it('同一间隔内的多次 offer 只在到点时发出最后一次', () => {
    const push = scheduler()
    push.offer('a', false)
    push.offer('ab', false)
    push.offer('abc', false)
    expect(sent).toEqual([])

    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    expect(sent).toEqual([{ html: 'abc', final: false }])
  })

  /**
   * ★ 收尾帧决定脚本何时执行(图表何时画出来),让它排在节流窗口后面,
   * 用户就会看到一张"内容齐了但还没画"的静态画面,长度取决于上一个 tick
   * 的余量 —— 一个谁也说不清为什么时长时短的空档。
   */
  it('收尾帧不等间隔,立刻发出', () => {
    const push = scheduler()
    push.offer('a', false)
    push.offer('abc', true)
    expect(sent).toEqual([{ html: 'abc', final: true }])
  })

  it('收尾帧会顶掉排队中的那一份,不会先发旧的再发新的', () => {
    const push = scheduler()
    push.offer('a', false)
    push.offer('abc', true)
    vi.advanceTimersByTime(PUSH_INTERVAL_MS * 3)
    expect(sent).toEqual([{ html: 'abc', final: true }])
  })

  it('到点之后的新内容重新计时,不是攒两帧一起发', () => {
    const push = scheduler()
    push.offer('a', false)
    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    push.offer('ab', false)
    expect(sent).toHaveLength(1)

    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.html).toBe('ab')
  })

  /** 卸载前不 flush 的话,最后一次内容会被丢掉 —— 表现为"图上少一块"。 */
  it('flush 把待发的那一份发出去', () => {
    const push = scheduler()
    push.offer('a', false)
    push.flush()
    expect(sent).toEqual([{ html: 'a', final: false }])
  })

  /** dispose 之后定时器必须停掉,否则组件消失后还会往一个已卸载的 frame 发消息。 */
  it('dispose 之后到点不再发送', () => {
    const push = scheduler()
    push.offer('a', false)
    push.dispose()
    vi.advanceTimersByTime(PUSH_INTERVAL_MS * 5)
    expect(sent).toEqual([])
  })

  it('没有待发内容时 flush 什么都不做', () => {
    const push = scheduler()
    push.offer('a', false)
    vi.advanceTimersByTime(PUSH_INTERVAL_MS)
    push.flush()
    expect(sent).toHaveLength(1)
  })
})
