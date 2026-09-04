/**
 * 队列纯函数的单测。
 *
 * 重点不在「函数返回了什么」,而在**顺序与合并规则**这两处最容易出错的地方:
 * 插话的排序依据、有 promoted 时不捎带 pending、超限退回而非截断。
 */
import { describe, expect, it } from 'vitest'
import type { SendOptions } from '../agent/run-request'
import type { QueuedInput } from '../domain/queued-input'
import {
  QUEUE_MAX_TEXT,
  SESSION_INPUT_TTL_MS,
  batchToParts,
  isLive,
  isValidSessionInput,
  makeQueuedInput,
  mergeBatch,
  pickNextBatch
} from '../domain/queued-input'

const OPTS: SendOptions = {
  workspaceId: 'w1',
  depth: 0,
  mode: 'normal',
  thinking: 'auto',
  webSearch: false,
  permissionMode: 'full',
  model: 'claude',
  skillIds: []
}

function q(id: string, text: string, at: number, promotedAt?: number): QueuedInput {
  const base = makeQueuedInput(id, text, OPTS, at)
  return promotedAt === undefined
    ? base
    : { ...base, status: 'promoted', promotedAt }
}

describe('pickNextBatch', () => {
  it('没有 promoted 时退回 FIFO 取一条 —— 对改造前行为的兼容承诺', () => {
    const queue = [q('a', '一', 1), q('b', '二', 2)]
    expect(pickNextBatch(queue).map((x) => x.id)).toEqual(['a'])
  })

  it('空队列返回空数组', () => {
    expect(pickNextBatch([])).toEqual([])
  })

  it('有 promoted 时只发 promoted,不捎带任何 pending', () => {
    const queue = [q('a', '一', 1), q('b', '二', 2, 100), q('c', '三', 3)]
    expect(pickNextBatch(queue).map((x) => x.id)).toEqual(['b'])
  })

  it('多条 promoted 按 promotedAt 升序,而不是入队序', () => {
    // b 先入队但后插话,应排在 c 后面
    const queue = [q('b', '二', 1, 200), q('c', '三', 2, 100)]
    expect(pickNextBatch(queue).map((x) => x.id)).toEqual(['c', 'b'])
  })

  it('promoted 但缺 promotedAt 时退化成入队序,而不是抢到最前', () => {
    const broken: QueuedInput = { ...q('x', '坏', 999), status: 'promoted' }
    const queue = [q('c', '三', 1, 100), broken]
    expect(pickNextBatch(queue).map((x) => x.id)).toEqual(['c', 'x'])
  })
})

describe('mergeBatch', () => {
  it('按顺序空行拼接', () => {
    const r = mergeBatch([q('a', '一', 1), q('b', '二', 2)])
    expect(r.text).toBe('一\n\n二')
    expect(r.deferredIds).toEqual([])
  })

  it('跳过纯空白条目但不影响其余拼接', () => {
    const r = mergeBatch([q('a', '一', 1), q('b', '   ', 2), q('c', '三', 3)])
    expect(r.text).toBe('一\n\n三')
  })

  it('附件按 url 去重', () => {
    const withFiles = (id: string, urls: string[]): QueuedInput => ({
      ...q(id, id, 1),
      attachments: urls.map((u) => ({ kind: 'image' as const, name: u, url: u }))
    })
    const a = 'ncw://attachments/sessions/S1/01J8A.png'
    const b = 'ncw://attachments/sessions/S1/01J8B.png'
    const r = mergeBatch([withFiles('a', [a, b]), withFiles('b', [b])])
    expect(r.attachments.map((x) => x.url)).toEqual([a, b])
  })

  it('超限时退回而不是截断 —— 首条无论多长都必须完整发出', () => {
    const long = q('a', 'x'.repeat(QUEUE_MAX_TEXT + 10), 1, 1)
    const r = mergeBatch([long, q('b', '二', 2, 2)])
    expect(r.text).toBe('x'.repeat(QUEUE_MAX_TEXT + 10))
    expect(r.deferredIds).toEqual(['b'])
  })

  it('空批次得到空文本', () => {
    expect(mergeBatch([]).text).toBe('')
  })
})

describe('batchToParts', () => {
  it('文本在前,图片走 ncw:// 的 dataRef,mime 按扩展名推', () => {
    const url = 'ncw://attachments/sessions/S1/01J8A.PNG'
    const parts = batchToParts({
      text: '你好',
      attachments: [{ kind: 'image', name: 'a', url }],
      deferredIds: []
    })
    expect(parts).toEqual([
      { type: 'text', text: '你好' },
      { type: 'image', mime: 'image/png', dataRef: url }
    ])
  })

  it('非图片附件降级成文本行,不伪造 ContentPart 类型', () => {
    const parts = batchToParts({
      text: '',
      attachments: [
        { kind: 'file', name: 'r.pdf', url: 'ncw://attachments/sessions/S1/01J8B.pdf' }
      ],
      deferredIds: []
    })
    expect(parts).toEqual([{ type: 'text', text: '[附件] r.pdf' }])
  })
})

describe('isValidSessionInput', () => {
  const now = 1_000_000_000
  const good = { v: 1 as const, draft: '半句话', queued: [q('a', '一', 1)], savedAt: now }

  it('接受当前版本的完整存档', () => {
    expect(isValidSessionInput(good, now)).toBe(true)
  })

  it('版本不符整份丢弃,不做部分修复', () => {
    expect(isValidSessionInput({ ...good, v: 2 }, now)).toBe(false)
  })

  it('超过 TTL 的存档丢弃', () => {
    expect(isValidSessionInput({ ...good, savedAt: now - SESSION_INPUT_TTL_MS - 1 }, now)).toBe(
      false
    )
  })

  it('队列里混进终态条目视为无效 —— 终态本就不该被落盘', () => {
    const zombie = { ...q('z', '僵尸', 1), status: 'consumed' }
    expect(isValidSessionInput({ ...good, queued: [zombie] }, now)).toBe(false)
  })

  it('非对象输入不崩', () => {
    expect(isValidSessionInput(null, now)).toBe(false)
    expect(isValidSessionInput('{}', now)).toBe(false)
  })
})

describe('序列化往返', () => {
  it('QueuedInput 全字段可 JSON 往返 —— 落盘的前提', () => {
    const item = { ...q('a', '一', 1, 5), attachments: [{ kind: 'image' as const, name: 'n', url: 'ncw://attachments/sessions/S1/p.png' }] }
    expect(JSON.parse(JSON.stringify(item))).toEqual(item)
  })
})

describe('isLive', () => {
  it('只有 pending / promoted 进列表', () => {
    expect(isLive(q('a', '一', 1))).toBe(true)
    expect(isLive(q('b', '二', 1, 2))).toBe(true)
    expect(isLive({ ...q('c', '三', 1), status: 'consumed' })).toBe(false)
    expect(isLive({ ...q('d', '四', 1), status: 'dropped' })).toBe(false)
  })
})
