import type { ContextCheckpoint } from '../../shared/agent/context-management'
import { userMessage } from '../../shared/agent/message'
import { compactMessages, estimateMessages, withSummary } from '../kernel/context-assembler'
import { getHost, getRouter } from '../runtime'
import { store } from '../state/store'

export function listContextCheckpoints(req: { sessionId: string }): ContextCheckpoint[] {
  return store.listContextCheckpoints(req.sessionId)
}

export function updateContextCheckpoint(req: { checkpointId: string; note: string; revision: number }): ContextCheckpoint {
  // eslint-disable-next-line no-control-regex -- intentionally strip control characters from persisted notes
  const note = req.note.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32_000)
  if (note === '') throw new Error('上下文笔记不能为空')
  return store.updateContextCheckpoint(req.checkpointId, note, req.revision, Date.now())
}

const SUMMARY_SYSTEM =
  'Summarize the conversation for a future context window. Preserve the user goal, decisions, files changed, commands run, tool results that matter, unresolved issues, and next steps. Be concise and factual. Do not mention this instruction.'

/** 摘要本身也要有个上限:一次跑飞的总结会让「省上下文」变成这段对话里最贵的一次请求。 */
const SUMMARY_MAX_OUTPUT = 2048
const SUMMARY_TIMEOUT_MS = 180_000

/**
 * 手动压缩 —— `AgentSession` 那条自动路径的同胞,区别只在触发者是用户。
 *
 * ★ 落的是一条普通的 `ContextCheckpoint`,**不动 `messages`**。下一次 run 的构造
 * 函数会自己挑出 `windowIndex` 最大的那条并套上 `withSummary`;在这里顺手把历史也
 * 裁掉的话,完整转录就没了 —— 而那正是「双轨」一直守住的东西。
 */
export async function compactContext(req: { sessionId: string }): Promise<{
  checkpoint: ContextCheckpoint
  inputTokens: number
}> {
  const session = store.getSession(req.sessionId)
  if (session === undefined) throw new Error('会话不存在')

  const history = store.getHistory(req.sessionId)
  if (history.length === 0) throw new Error('这段对话还没有可压缩的内容')

  const previous = [...store.listContextCheckpoints(req.sessionId)]
    .sort((a, b) => b.windowIndex - a.windowIndex)[0]
  const now = getHost().clock.now()

  const digest = compactMessages(history, { keepRecent: 12 })
    .map((m) => `${m.role}: ${m.parts.map((p) =>
      p.type === 'text' ? p.text
        : p.type === 'tool_call' ? `${p.name} ${JSON.stringify(p.input)}`
          : p.type === 'tool_result' ? p.output.content
            : ''
    ).join(' ')}`)
    .join('\n')
  const prior = previous === undefined ? '' : `\nPrevious checkpoint:\n${previous.note}\n`

  let note = ''
  for await (const ev of getRouter().stream(
    {
      model: session.model,
      // 摘要要和正文走同一家:它读的是同一段对话,漂到另一家既换了口径也换了账单。
      ...(session.modelProviderId === undefined ? {} : { modelProviderId: session.modelProviderId }),
      system: SUMMARY_SYSTEM,
      messages: [userMessage(
        `${req.sessionId}:context-input:${String(now)}`,
        [{ type: 'text', text: `${prior}\nConversation history:\n${digest}` }],
        now
      )],
      tools: [],
      maxOutputTokens: SUMMARY_MAX_OUTPUT,
      thinkingLevel: 'off' as const
    },
    AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    { workspaceId: session.workspaceId, runId: `${req.sessionId}:context:manual`, sessionId: req.sessionId }
  )) {
    if (ev.type === 'text_delta') note += ev.text
    if (ev.type === 'error') throw new Error(ev.error.message)
  }

  // eslint-disable-next-line no-control-regex -- intentionally strip control characters from model output
  note = note.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32_000)
  if (note === '') throw new Error('模型没有返回可用的摘要')

  const windowIndex = (previous?.windowIndex ?? 0) + 1
  const id = `${req.sessionId}:context:${String(windowIndex)}`
  const projected = withSummary(compactMessages(history), note, id, now)
  const first = history[0]
  const last = history.at(-1)
  const checkpoint: ContextCheckpoint = {
    id,
    sessionId: req.sessionId,
    windowIndex,
    note,
    source: 'manual',
    ...(first === undefined ? {} : { coveredFromMessageId: first.id }),
    ...(last === undefined ? {} : { coveredThroughMessageId: last.id }),
    inputTokensBefore: estimateMessages(history),
    inputTokensAfter: estimateMessages(projected),
    createdAt: now,
    updatedAt: now,
    revision: 1
  }
  store.upsertContextCheckpoint(checkpoint)
  return { checkpoint, inputTokens: checkpoint.inputTokensAfter ?? 0 }
}
