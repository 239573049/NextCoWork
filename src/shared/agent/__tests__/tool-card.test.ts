import { describe, expect, it } from 'vitest'
import { MAX_CARD_BYTES, sanitizeToolCard } from '../tool-card'

const NO_FRAMES: ReadonlySet<string> = new Set()
const FRAMES = new Set(['task.card'])

describe('sanitizeToolCard · declarative', () => {
  it('保留白名单原语,钳制越界字段', () => {
    const card = sanitizeToolCard(
      {
        kind: 'declarative',
        blocks: [
          { type: 'status', label: '进行中', tone: 'warn' },
          { type: 'progress', fraction: 2 }, // 越界 → 钳到 1
          { type: 'keyValue', rows: [{ label: '标题', value: '修 bug', tone: 'nope' }] } // 非法 tone 丢弃
        ]
      },
      NO_FRAMES
    )
    expect(card).toEqual({
      kind: 'declarative',
      blocks: [
        { type: 'status', label: '进行中', tone: 'warn' },
        { type: 'progress', fraction: 1 },
        { type: 'keyValue', rows: [{ label: '标题', value: '修 bug' }] }
      ]
    })
  })

  it('★ 未知块类型降级丢弃,不打崩整张卡(前向兼容)', () => {
    const card = sanitizeToolCard(
      { kind: 'declarative', blocks: [{ type: 'future_widget', x: 1 }, { type: 'text', value: '还在' }] },
      NO_FRAMES
    )
    expect(card).toEqual({ kind: 'declarative', blocks: [{ type: 'text', value: '还在' }] })
  })

  it('★ image dataRef 只认 data:/ncw://,别的 scheme 整块丢', () => {
    const bad = sanitizeToolCard(
      { kind: 'declarative', blocks: [{ type: 'image', dataRef: 'https://evil/x.png' }] },
      NO_FRAMES
    )
    expect(bad).toBeUndefined() // 唯一的块被丢 → 空 blocks → 整卡 undefined
    const ok = sanitizeToolCard(
      { kind: 'declarative', blocks: [{ type: 'image', dataRef: 'ncw://a' }, { type: 'image', dataRef: 'data:image/png;base64,AA' }] },
      NO_FRAMES
    )
    expect(ok?.kind).toBe('declarative')
    expect(ok?.kind === 'declarative' && ok.blocks.length).toBe(2)
  })

  it('★ link href 只认 https', () => {
    expect(
      sanitizeToolCard({ kind: 'declarative', blocks: [{ type: 'link', href: 'javascript:alert(1)' }] }, NO_FRAMES)
    ).toBeUndefined()
    expect(
      sanitizeToolCard({ kind: 'declarative', blocks: [{ type: 'link', href: 'https://ok' }] }, NO_FRAMES)?.kind
    ).toBe('declarative')
  })

  it('button:actionId + label 必填,tone 校验', () => {
    const ok = sanitizeToolCard(
      { kind: 'declarative', blocks: [{ type: 'button', actionId: 'approve', label: '批准', tone: 'ok' }] },
      NO_FRAMES
    )
    expect(ok).toEqual({ kind: 'declarative', blocks: [{ type: 'button', actionId: 'approve', label: '批准', tone: 'ok' }] })
    // 缺 actionId / 空 actionId / 缺 label → 该块丢弃
    expect(sanitizeToolCard({ kind: 'declarative', blocks: [{ type: 'button', label: '批准' }] }, NO_FRAMES)).toBeUndefined()
    expect(sanitizeToolCard({ kind: 'declarative', blocks: [{ type: 'button', actionId: '', label: 'x' }] }, NO_FRAMES)).toBeUndefined()
    expect(sanitizeToolCard({ kind: 'declarative', blocks: [{ type: 'button', actionId: 'a' }] }, NO_FRAMES)).toBeUndefined()
  })

  it('空 blocks → undefined(退纯文本)', () => {
    expect(sanitizeToolCard({ kind: 'declarative', blocks: [] }, NO_FRAMES)).toBeUndefined()
  })

  it('★ 超独立字节预算的卡整体丢弃', () => {
    const huge = 'x'.repeat(MAX_CARD_BYTES)
    // 单字段会先被 MAX_FIELD_CHARS 截,但多块叠加仍可超预算
    const blocks = Array.from({ length: 8 }, () => ({ type: 'text', value: huge }))
    expect(sanitizeToolCard({ kind: 'declarative', blocks }, NO_FRAMES)).toBeUndefined()
  })
})

describe('sanitizeToolCard · frame', () => {
  it('viewType 必须在该插件声明的 cardViews 内', () => {
    expect(sanitizeToolCard({ kind: 'frame', viewType: 'task.card', data: { a: 1 } }, FRAMES)).toEqual({
      kind: 'frame',
      viewType: 'task.card',
      data: { a: 1 }
    })
    expect(sanitizeToolCard({ kind: 'frame', viewType: 'other.card', data: {} }, FRAMES)).toBeUndefined()
    expect(sanitizeToolCard({ kind: 'frame', viewType: 'task.card', data: {} }, NO_FRAMES)).toBeUndefined()
  })

  it('缺 data 补 null;不可序列化 data 整卡丢弃', () => {
    expect(sanitizeToolCard({ kind: 'frame', viewType: 'task.card' }, FRAMES)).toEqual({
      kind: 'frame',
      viewType: 'task.card',
      data: null
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(sanitizeToolCard({ kind: 'frame', viewType: 'task.card', data: cyclic }, FRAMES)).toBeUndefined()
  })
})

describe('sanitizeToolCard · 非法输入', () => {
  it('非对象 / 未知 kind → undefined', () => {
    for (const raw of [null, undefined, 42, 'x', [], { kind: 'weird' }, {}]) {
      expect(sanitizeToolCard(raw, FRAMES)).toBeUndefined()
    }
  })
})
