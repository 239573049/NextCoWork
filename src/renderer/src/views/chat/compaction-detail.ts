/**
 * 压缩检查点 → 面板上那一排统计药丸,以及「这条检查点有没有 X 可看」的判断。
 *
 * ## 需求
 *
 * 面板要同时服务两种检查点(机械压缩 / 模型摘要),而它们能提供的事实**不一样**:
 * 机械压缩没有 digest,老检查点连统计都没有。把这些分支写在 JSX 里的结果是
 * 一串 `detail?.x !== undefined &&`,既看不出规则也测不了。抽到这里之后,
 * 「哪些药丸该亮」是一个可以单测的纯函数。
 *
 * ★ **「没有这份事实」和「事实是 0」必须分开。** 老检查点的 `detail` 整个缺席,
 * 那时面板要什么都不画,而不是画一排 0 —— 一排 0 是个断言,它会让人以为
 * 那次压缩什么都没丢,而真相是我们不知道。
 */
import type { ContextCheckpoint } from '../../../../shared/agent/context-management'

/** 一枚统计药丸:i18n key + 插值参数。文案本身不在这里(§6)。 */
export interface CompactionStat {
  key: 'context.panel.folded' | 'context.panel.foldedTools' | 'context.panel.dropped' | 'context.panel.digestOmitted'
  count: number
  /** 需要额外解释的那几项 —— 界面上跟一行小字。 */
  hint?: 'context.panel.droppedHint'
}

export function compactionStats(checkpoint: ContextCheckpoint): CompactionStat[] {
  const detail = checkpoint.detail
  if (detail === undefined) return []
  const stats: CompactionStat[] = []
  if (detail.foldedMessages !== undefined && detail.foldedMessages > 0) {
    stats.push({ key: 'context.panel.folded', count: detail.foldedMessages })
  }
  if (detail.foldedToolOutputs !== undefined && detail.foldedToolOutputs > 0) {
    stats.push({ key: 'context.panel.foldedTools', count: detail.foldedToolOutputs })
  }
  /*
    ★ 丢弃**单独一项、还带一行解释**,不和折叠合并成一个数。
    折叠是「工具输出被清空、骨架还在」,丢弃是「这几条真的不再发给模型」——
    合成一个数之后用户没办法知道追问还能不能把内容问回来。
  */
  if (detail.droppedMessages !== undefined && detail.droppedMessages > 0) {
    stats.push({
      key: 'context.panel.dropped',
      count: detail.droppedMessages,
      hint: 'context.panel.droppedHint'
    })
  }
  if (detail.digestOmittedMessages !== undefined && detail.digestOmittedMessages > 0) {
    stats.push({ key: 'context.panel.digestOmitted', count: detail.digestOmittedMessages })
  }
  return stats
}

/**
 * 这条检查点有没有「摘要没覆盖到的那一段」要警告。
 *
 * ★ 警告的落点是**用户能做的事**:它意味着这次摘要是在不完整的输入上写的,
 * 所以模型接下来对那一段的说法不可信。文案里因此要写明「它们不会被裁掉」——
 * 否则读起来像是丢了数据,而实际上投影会保守地把它们留在上下文里。
 */
export function hasUncoveredGap(checkpoint: ContextCheckpoint): boolean {
  return checkpoint.detail?.uncoveredFromMessageId !== undefined
}
