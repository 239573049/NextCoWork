/**
 * 上下文压缩面板的文案。
 *
 * ## 为什么单独开一个文件
 *
 * 压缩这一块的 key 从「一条分隔线 + 一段笔记」长成了「折叠/丢弃统计 + 覆盖缺口
 * 警告 + digest 原文 + 压缩后实际上下文」四块,继续往 `index.tsx` 那三千行里堆
 * 只会让下一次改动更难(AGENTS.md §6.3)。既有的 `chat.compaction.*` /
 * `chat.contextSource.*` **留在原处不动** —— 搬家会把一次加文案变成一次全仓库改引用,
 * 而那正是并发改动里最容易被静默覆盖的那种 diff。
 *
 * ## 这里的措辞在守什么
 *
 * 「折叠」和「丢弃」必须是两个词。前者是工具输出被清空、骨架还在,用户往回翻
 * 聊天记录还能看到原文;后者是那几条**真的不再发给模型**了。写成同一句话的话,
 * 用户会以为追问一下模型就能把内容想起来,而它根本看不见。
 */
type Params = Record<string, string | number>

export const contextPanelZh = {
  'context.panel.stats': '压缩统计',
  'context.panel.folded': ({ count }: Params) => `折叠 ${String(count)} 条`,
  'context.panel.foldedTools': ({ count }: Params) => `清空 ${String(count)} 处工具输出`,
  'context.panel.dropped': ({ count }: Params) => `移出上下文 ${String(count)} 条`,
  'context.panel.droppedHint': '这些消息不再发给模型,只留下一份提要。聊天记录里仍然能往回翻。',
  'context.panel.uncovered': '有消息没能进入摘要',
  'context.panel.uncoveredHint': '摘要输入超出预算,这几条被跳过了。它们不会被裁掉,仍按原样发给模型。',
  'context.panel.digestOmitted': ({ count }: Params) => `摘要输入省略 ${String(count)} 条`,

  'context.panel.tabNote': '摘要',
  'context.panel.tabDigest': '摘要输入',
  'context.panel.tabWindow': '压缩后上下文',
  'context.panel.digestEmpty': '这条检查点没有摘要输入(自动压缩不发模型请求)。',
  'context.panel.digestHint': '这是发给摘要模型的原文。它已按预算截断,被省略的部分不可恢复。',

  'context.panel.windowHint': '按当前对话重算的投影。最新一条检查点即下一次请求会发出去的那一份;更早的是复原。',
  'context.panel.windowLoading': '正在计算…',
  'context.panel.windowFailed': '无法计算这份上下文。',
  'context.panel.windowTotals': ({ kept, all }: Params) => `${String(kept)} / ${String(all)} token 仍在上下文里`,
  'context.panel.windowDropped': ({ count }: Params) => `${String(count)} 条已不在上下文里`,
  'context.panel.kind.summary': '摘要',
  'context.panel.kind.skeleton': '提要',
  'context.panel.kind.folded': '已折叠',
  'context.panel.kind.verbatim': '原文',
  'context.panel.roleUser': '用户',
  'context.panel.roleAssistant': '助手',
  'context.panel.tokens': ({ count }: Params) => `${String(count)} token`
}

export const contextPanelEn: Record<keyof typeof contextPanelZh, string | ((p: Params) => string)> = {
  'context.panel.stats': 'Compaction stats',
  'context.panel.folded': ({ count }: Params) => `${String(count)} folded`,
  'context.panel.foldedTools': ({ count }: Params) => `${String(count)} tool output(s) cleared`,
  'context.panel.dropped': ({ count }: Params) => `${String(count)} removed from context`,
  'context.panel.droppedHint': 'These messages are no longer sent to the model; only an outline remains. They are still in the transcript above.',
  'context.panel.uncovered': 'Some messages never reached the summary',
  'context.panel.uncoveredHint': 'The summary input hit its budget and skipped them. They are not trimmed — they are still sent verbatim.',
  'context.panel.digestOmitted': ({ count }: Params) => `${String(count)} message(s) omitted from the summary input`,

  'context.panel.tabNote': 'Summary',
  'context.panel.tabDigest': 'Summary input',
  'context.panel.tabWindow': 'Context after compaction',
  'context.panel.digestEmpty': 'This checkpoint has no summary input — automatic compaction makes no model request.',
  'context.panel.digestHint': 'This is the text sent to the summarizing model. It was truncated to a budget; the omitted parts are not recoverable.',

  'context.panel.windowHint': 'Recomputed from the current conversation. For the newest checkpoint this is exactly what the next request sends; earlier ones are reconstructions.',
  'context.panel.windowLoading': 'Computing…',
  'context.panel.windowFailed': 'This context could not be computed.',
  'context.panel.windowTotals': ({ kept, all }: Params) => `${String(kept)} / ${String(all)} tokens still in context`,
  'context.panel.windowDropped': ({ count }: Params) => `${String(count)} message(s) no longer in context`,
  'context.panel.kind.summary': 'Summary',
  'context.panel.kind.skeleton': 'Outline',
  'context.panel.kind.folded': 'Folded',
  'context.panel.kind.verbatim': 'Verbatim',
  'context.panel.roleUser': 'User',
  'context.panel.roleAssistant': 'Assistant',
  'context.panel.tokens': ({ count }: Params) => `${String(count)} tokens`
}
