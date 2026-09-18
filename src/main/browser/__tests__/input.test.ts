import { describe, expect, it, vi } from 'vitest'
import { CdpPageSession, type CdpTransport } from '../cdp-session'
import { BrowserInputController } from '../input'

function harness(evaluateValue: unknown = { ok: true, x: 20, y: 30 }) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const transport: CdpTransport = {
    send: vi.fn(async (method, params) => {
      calls.push({ method, ...(params === undefined ? {} : { params }) })
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Runtime.evaluate') return { result: { value: evaluateValue } }
      return {}
    }),
    close: vi.fn(async () => undefined)
  }
  const events: string[] = []
  const input = new BrowserInputController(
    new CdpPageSession(transport),
    async () => ({ width: 100, height: 100 }),
    (kind) => events.push(kind)
  )
  return { input, calls, events }
}

describe('browser CDP input', () => {
  it('ref 不存在时要求重新快照且不派发鼠标事件', async () => {
    const { input, calls } = harness({ ok: false, error: 'missing_ref' })
    input.setSnapshot('snapshot-1')

    await expect(input.clickRef('e2')).rejects.toThrow('fresh browser_snapshot')
    expect(calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('一次状态变更后消费快照，第二次点击必须重新观察', async () => {
    const { input } = harness()
    input.setSnapshot('snapshot-1')

    await input.clickRef('e2')

    await expect(input.clickRef('e2')).rejects.toThrow('fresh browser_snapshot')
  })

  it('坐标动作要求截图且拒绝 viewport 外坐标', async () => {
    const { input } = harness()

    await expect(input.cuaClick({ x: 20, y: 30 })).rejects.toThrow('fresh browser_screenshot')
    input.setScreenshotReady()
    await expect(input.cuaClick({ x: 101, y: 30 })).rejects.toThrow('outside the 100x100 viewport')
  })

  it('拖拽按输入顺序保留每一个路径点', async () => {
    const { input, calls, events } = harness()
    input.setScreenshotReady()

    await input.cuaDrag([{ x: 1, y: 2 }, { x: 10, y: 20 }, { x: 30, y: 40 }])

    const moved = calls
      .filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseMoved')
      .map((call) => [call.params?.x, call.params?.y])
    expect(moved).toEqual([[1, 2], [10, 20], [30, 40]])
    expect(events).toEqual(['move', 'move', 'click'])
  })
})
