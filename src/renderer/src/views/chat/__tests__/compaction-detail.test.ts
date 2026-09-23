/**
 * 压缩详情面板那排统计药丸的规则。
 *
 * ★ 盯的是一条很容易被「简化」掉的区分:**「没有这份事实」和「事实是 0」不一样**。
 * 老检查点的 `detail` 整个缺席,那时面板必须什么都不画 —— 画一排 0 是个断言,
 * 它会让人以为那次压缩什么都没丢,而真相是我们不知道。
 */
import { describe, expect, it } from 'vitest'
import type { ContextCheckpoint } from '../../../../../shared/agent/context-management'
import { compactionStats, hasUncoveredGap } from '../compaction-detail'

const checkpoint = (over: Partial<ContextCheckpoint> = {}): ContextCheckpoint => ({
  id: 'sess:context:1',
  sessionId: 'sess',
  windowIndex: 1,
  note: '摘要',
  source: 'model',
  createdAt: 0,
  updatedAt: 0,
  revision: 1,
  ...over
})

describe('compactionStats', () => {
  it('老检查点(没有 detail)一个药丸都不画', () => {
    expect(compactionStats(checkpoint())).toEqual([])
  })

  it('全是 0 的 detail 同样不画 —— 0 条折叠不是一条要报的事实', () => {
    expect(compactionStats(checkpoint({ detail: { foldedMessages: 0, droppedMessages: 0 } }))).toEqual([])
  })

  /**
   * ★ 折叠和丢弃**必须分成两项**。前者是工具输出被清空、骨架还在,用户往回翻
   * 聊天记录还能看到原文;后者是那几条真的不再发给模型。合成一个数之后,
   * 用户没办法判断追问还能不能把内容问回来。
   */
  it('★ 折叠与丢弃各报各的,丢弃还要带一行解释', () => {
    const stats = compactionStats(
      checkpoint({ detail: { foldedMessages: 12, foldedToolOutputs: 7, droppedMessages: 5 } })
    )
    expect(stats.map((s) => s.key)).toEqual([
      'context.panel.folded',
      'context.panel.foldedTools',
      'context.panel.dropped'
    ])
    expect(stats.find((s) => s.key === 'context.panel.dropped')?.hint).toBe('context.panel.droppedHint')
    expect(stats.find((s) => s.key === 'context.panel.folded')?.hint).toBeUndefined()
  })

  it('digest 省略条数单独成一项', () => {
    const stats = compactionStats(checkpoint({ detail: { digestOmittedMessages: 3 } }))
    expect(stats).toEqual([{ key: 'context.panel.digestOmitted', count: 3 }])
  })
})

describe('hasUncoveredGap', () => {
  it('只有真的记下了缺口起点才警告', () => {
    expect(hasUncoveredGap(checkpoint())).toBe(false)
    expect(hasUncoveredGap(checkpoint({ detail: { digestOmittedMessages: 2 } }))).toBe(false)
    expect(hasUncoveredGap(checkpoint({ detail: { uncoveredFromMessageId: 'm7' } }))).toBe(true)
  })
})
