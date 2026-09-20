import type { ContextCheckpoint, ContextPreview } from '../../shared/agent/context-management'
import { effectiveContextWindow } from '../../shared/agent/context-management'
import { normalizeEnvironmentRef } from '../../shared/domain/environment'
import type { ContextPreviewRequest } from '../../shared/ipc/contract'
import { resolveMaxOutputTokens } from '../../shared/agent/run-request'
import { userMessage } from '../../shared/agent/message'
import { agentRegistry } from '../kernel/agent/registry'
import { modePromptFor, modeRegistry } from '../kernel/mode/registry'
import { skillRegistry } from '../kernel/skill/registry'
import { taskTool } from '../kernel/tool/builtin/task'
import { ToolRegistry } from '../kernel/tool/registry'
import {
  COMPACTION_SYSTEM,
  assemble,
  buildCompactionPrompt,
  compactionDigestBudget,
  estimateMessages,
  projectContextWindow,
  sanitizeSummaryNote,
  summaryOutputTokens
} from '../kernel/context-assembler'
import { connectedWorkspaceMcpTools, getHost, getRouter, getTools, loadInstructions } from '../runtime'
import { store } from '../state/store'

export function listContextCheckpoints(req: { sessionId: string }): ContextCheckpoint[] {
  return store.listContextCheckpoints(req.sessionId)
}

export function updateContextCheckpoint(req: { checkpointId: string; note: string; revision: number }): ContextCheckpoint {
  /*
    ★ 走 `sanitizeSummaryNote`,不再就地写一条正则。原来那条
    `replace(/[\u0000-\u001f\u007f]/g, '')` 的字符区间**连换行一起削** —— 用户在
    分隔线里分好段落的笔记一存就被压成一整段,而界面上不会有任何提示。
    摘要本身现在是八节 Markdown,更加丢不起换行。
  */
  const note = sanitizeSummaryNote(req.note)
  if (note === '') throw new Error('上下文笔记不能为空')
  return store.updateContextCheckpoint(req.checkpointId, note, req.revision, Date.now())
}

const SUMMARY_TIMEOUT_MS = 180_000

/**
 * 手动压缩 —— `AgentSession` 那条自动路径的同胞,区别只在触发者是用户。
 *
 * ★ 提示词、digest、输出上限、消毒**四样都和自动那条读同一份**
 * (`context-assembler.ts` 的「摘要压缩」一节)。这里原先有它们的一整套副本,
 * 而两份已经开始分头演化 —— 只改一侧的结果是「自动压出来有八节、手动压出来只有一段」,
 * 且不报任何错。
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

  /*
    ★ 这条路径不知道会话有没有开「最大上下文」——那是 `RunRequest` 上的字段,
    而这里来自一次菜单点击。按**关**算:预算取小只会让 digest 更紧,不会让请求超窗。
  */
  const alias = getRouter().resolveModel(session.model, session.modelProviderId)
  const window = effectiveContextWindow(alias?.contextWindow, false)

  let note = ''
  for await (const ev of getRouter().stream(
    {
      model: session.model,
      // 摘要要和正文走同一家:它读的是同一段对话,漂到另一家既换了口径也换了账单。
      ...(session.modelProviderId === undefined ? {} : { modelProviderId: session.modelProviderId }),
      system: COMPACTION_SYSTEM,
      messages: [userMessage(
        `${req.sessionId}:context-input:${String(now)}`,
        [{
          type: 'text',
          text: buildCompactionPrompt({
            messages: history,
            ...(previous === undefined ? {} : { previousNote: previous.note }),
            budget: compactionDigestBudget(window)
          })
        }],
        now
      )],
      tools: [],
      maxOutputTokens: summaryOutputTokens(alias?.maxOutputTokens, window),
      thinkingLevel: 'off' as const
    },
    AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    { workspaceId: session.workspaceId, runId: `${req.sessionId}:context:manual`, sessionId: req.sessionId }
  )) {
    if (ev.type === 'text_delta') note += ev.text
    if (ev.type === 'error') throw new Error(ev.error.message)
  }

  note = sanitizeSummaryNote(note)
  if (note === '') throw new Error('模型没有返回可用的摘要')

  const windowIndex = (previous?.windowIndex ?? 0) + 1
  const id = `${req.sessionId}:context:${String(windowIndex)}`
  const first = history[0]
  const last = history.at(-1)
  /*
    ★ 「省了多少」必须按**下一次 run 真的会发出去的那一份**算,所以这里走
    `projectContextWindow` —— 和 `AgentSession` 恢复检查点时是同一个函数、同一套
    切点规则。自己再拼一遍 `withSummary(compactMessages(...))` 的话,这个数会
    偏大一整段被裁掉的历史,而用户看到的「省下 N」是纯编的。
    覆盖锚点给最后一条:摘要读的就是到此为止的全部转录。
  */
  const projected = projectContextWindow({
    messages: history,
    summary: { note, id, ...(last === undefined ? {} : { coveredThroughMessageId: last.id }) },
    now
  }).messages
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

/**
 * 还没发过请求时的占用归因 —— 把这一轮**会**发出去的东西装配一遍,但不发。
 *
 * ★ **一个副作用都不留。** 它读的全是进程里已经有的那份:全局工具注册表、
 * 技能注册表当前的内容、这个工作区**已经连上**的 MCP。三件真正会动东西的事
 * 一件都不做 —— 不 `refreshSkills`(那会 `replaceAll` 这个工作区那一份注册表,父 run
 * 跑到一半时把它换掉),不 `prepareWorkspaceMcp`(那会去连服务器),不租环境。
 * 理由很朴素:这条通道是用户点开一个菜单时被调的,而一个菜单不该拉起子进程。
 *
 * ★ 代价说清楚:**MCP 还没连上时那一档就是 0**,等它连上再点开才有数。
 * 这比「为了画个百分比先把所有服务器拉起来」要诚实,也比「装作没有这一档」要有用。
 *
 * ★ `messages` 那一档不是估的空值,是**从库里读的真历史** —— 所以重开一个聊过
 * 很久的老会话,这张卡当场就是对的,不必再发一条消息去把它唤醒。
 */
export async function previewContext(req: ContextPreviewRequest): Promise<ContextPreview | undefined> {
  const workspace = store.getWorkspace(req.workspaceId)
  if (workspace === undefined) return undefined

  /*
    ★ 复刻 `runtime.ts` 的 `snapshotRunTools`,但**不要求一个环境**。
    远程与否只影响两件事(去掉 MCP/浏览器、换掉 Bash 的描述),而前者从
    工作区的环境引用就能判断,后者只是几十个 token 的措辞差 —— 为它去租一条
    SSH 连接是本末倒置。
  */
  const remote = normalizeEnvironmentRef(workspace.environment).kind === 'connection'
  const registry = new ToolRegistry()
  for (const tool of getTools().snapshot()) {
    if (remote && (tool.source.kind === 'mcp' || tool.internalId.startsWith('browser_'))) continue
    registry.register(tool)
  }
  registry.register(taskTool(agentRegistry(req.workspaceId).list()))
  if (!remote) {
    for (const tool of connectedWorkspaceMcpTools(req.workspaceId)?.snapshot() ?? []) registry.register(tool)
  }

  const disabled = new Set(store.getDisabledSkillIds())
  const skills = skillRegistry(req.workspaceId).list().filter((s) => !disabled.has(s.id) && !s.unavailableReason)

  /*
    AGENTS.md 算进去 —— `loadInstructions` 不需要一个已经租好的环境,本地工作区
    就是两次文件读。★ 读不到不算失败:远程工作区没连上时它会抛,而「少一档
    说明文字」远远好过「整张卡打不开」。
  */
  let projectInstructions = ''
  try { projectInstructions = await loadInstructions(req.workspaceId) } catch {
    // 远程工作区没连上时保持为空字符串
  }

  const alias = getRouter().resolveModel(req.model, req.modelProviderId)
  const mode = modeRegistry(req.workspaceId).resolve(req.mode)
  const tools = registry.snapshot({
    ...(mode.tools === undefined ? {} : { allowList: mode.tools }),
    network: req.webSearch
  }).map(({ execute: _execute, ...info }) => info)

  /*
    ★ 空会话必须塞一条**占位的空用户消息**,否则 AGENTS.md 根本不会被算进去:
    `decorate()` 把说明块注入的是「数组里第一条 user 消息」,一条都没有时它
    `return messages` 直接走人(见那个 `i === -1`)。于是一个写了两千字 AGENTS.md
    的仓库,在预览里那一档是 0 —— 而真发送时它一定在,因为那时至少有用户这一句。
    预览要回答的是「我下一条发出去会占多少」,所以把那条消息先摆上是**更准**不是更假;
    它自己只贡献一份消息开销(几个 token),落在 `messages` 档里,也是真花的。
  */
  const history = req.sessionId === '' ? [] : store.getHistory(req.sessionId)
  const messages = history.length > 0
    ? history
    : [userMessage('preview', [{ type: 'text', text: '' }], 0)]

  const { usage } = assemble({
    messages,
    tools,
    skills,
    ...(store.getSettings().personalization !== undefined
      ? { personalization: store.getSettings().personalization }
      : {}),
    mode: mode.id,
    modePrompt: modePromptFor(mode),
    thinking: req.thinking,
    model: req.model,
    ...(req.modelProviderId === undefined ? {} : { modelProviderId: req.modelProviderId }),
    workspaceRoot: workspace.rootPath,
    now: getHost().clock.now(),
    platform: getHost().platform,
    permissionMode: req.permissionMode,
    webSearch: req.webSearch,
    contextWindow: effectiveContextWindow(alias?.contextWindow, req.maxContext === true),
    // 需求：预览装配与正文共用同一个全局输出额度设置；当前返回值不暴露 shouldCompact，但不能让两条装配口径分叉。
    maxOutputTokens: resolveMaxOutputTokens(store.getSettings().maxOutputTokens, alias?.contextWindow),
    supportsThinking: alias?.capabilities.thinking ?? false,
    ...(alias?.reasoningEfforts !== undefined ? { reasoningEfforts: alias.reasoningEfforts } : {}),
    ...(alias?.thinkingConfig !== undefined ? { thinkingConfig: alias.thinkingConfig } : {}),
    /*
      ★ 不给 git 上下文 —— 它要 `environment.spawn`,而那是这个函数唯一拒绝付的代价。
      少掉的是 reminder 里几行分支名和状态,落在 `instructions` 那一档里,
      量级上可以忽略;真发送时它会回来。
      `todoToolName` 同理不给:空会话里推不出 todo,老会话里它只是个名字。
    */
    ...(projectInstructions === '' ? {} : { reminder: { projectInstructions } })
  })

  return { used: usage.used, window: usage.window, segments: usage.segments ?? [] }
}
