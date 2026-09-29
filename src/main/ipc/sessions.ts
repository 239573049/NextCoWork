/** 会话实体 IPC：所有读写都经过 state/store，避免 handler 直接写 SQL。 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Session, SessionChange } from '../../shared/domain/session'
import type { AgentMessage } from '../../shared/agent/message'
import { isToolResultOnly } from '../../shared/agent/message'
import { ownedImageFileNames, rehomeImageRefs, turnEndIndex } from '../../shared/agent/session-clone'
import type { SessionMode } from '../../shared/agent/run-request'
import { normalizeModeId } from '../../shared/domain/mode'
import { mimeOfExt } from '../../shared/domain/attachment'
import { ulid } from '../../shared/util/id'
import { runs } from '../kernel/run-registry'
import { windows } from '../window/registry'
import { store } from '../state/store'
import { removeSessionAttachmentFiles } from './storage'
import { uploadAttachment } from './attachment'
import { endGoalSession, restoreGoal } from '../goal/runtime'
import { ensureGoalRuntime } from '../runtime'
import { interactions } from '../kernel/interaction-gate'
import { IpcError } from './errors'

function changed(event: SessionChange): void {
  windows.emitToAll('sessions:changed', event)
}

export function listSessions(req: { workspaceId: string; archived?: boolean }) {
  const activeSessionIds = new Set(
    runs.activeRunIds().map((id) => runs.get(id)?.sessionId).filter((id): id is string => id !== undefined)
  )
  return store.listSessions(req.workspaceId, req.archived).map((item) => ({
    ...item,
    running: activeSessionIds.has(item.id)
  }))
}

export function getSession(req: { sessionId: string }) {
  const detail = store.getSessionDetail(req.sessionId)
  if (detail === undefined) throw new Error(`会话不存在: ${req.sessionId}`)
  if (detail.session.parentSessionId === undefined) {
    ensureGoalRuntime()
    restoreGoal(req.sessionId, detail.messages)
  }
  return detail
}

/** Replace a session transcript after an intentional user edit. */
export function replaceHistory(req: { sessionId: string; messages: AgentMessage[] }): void {
  if (runs.activeRunIds().some((id) => runs.get(id)?.sessionId === req.sessionId)) {
    throw new Error('有运行中的 Agent，请先停止任务后再编辑消息')
  }
  /*
    ★★ 手动编辑转录 = 永久脱离导入来源,且必须和替换**在同一个事务里**。

    分成两步的话,中间那一瞬同步器可以插进来:它看到的还是「未修改」,
    于是用源侧转录覆盖掉用户刚编辑的结果。放进同一个事务,两者不可能交错。

    ★ 只有**内容**修改算脱离。归档/收藏/改标题不是转录编辑 ——
    因为那些而丢掉正常同步,用户会觉得收藏一下就"坏了"。
  */
  store.tx(() => {
    store.replaceHistory(req.sessionId, req.messages)
    store.detachImportedSession(req.sessionId)
  })
  const session = store.getSession(req.sessionId)
  changed({ kind: 'history', sessionIds: [req.sessionId], workspaceId: session?.workspaceId })
}

export function createSession(req: { workspaceId: string; title?: string; sessionId?: string; mode?: SessionMode }): Session {
  const ws = store.getWorkspace(req.workspaceId)
  const session = store.ensureSession({
    id: req.sessionId,
    workspaceId: req.workspaceId,
    title: req.title,
    mode: normalizeModeId(req.mode ?? ws?.settings.defaultMode),
    rootPathAtCreation: ws?.rootPath ?? ''
  })
  changed({ kind: 'metadata', sessionIds: [session.id], workspaceId: req.workspaceId })
  return session
}

export function setMode(req: { sessionId: string; mode: SessionMode }): void {
  const session = store.getSession(req.sessionId)
  if (session === undefined) return
  const mode = normalizeModeId(req.mode)
  if (session.mode === mode) return
  store.putSession({ ...session, mode, updatedAt: Date.now() })
  changed({ kind: 'metadata', sessionIds: [session.id], workspaceId: session.workspaceId })
}

/**
 * 记住这条会话选中的模型。
 *
 * ★ 不动 `updatedAt`:换个模型不是「这条对话有了新进展」,碰它会让侧边栏的
 *   最近顺序因为一次纯 UI 操作而跳动。
 * ★ `modelProviderId` **无条件写**,不能条件展开 —— 别名换了而供应商没跟着换,
 *   留下的就是「新别名 + 旧供应商」这个谁也没配过的组合(同 runtime.ts 那处)。
 */
export function setModel(req: { sessionId: string; model: string; modelProviderId?: string }): void {
  const session = store.getSession(req.sessionId)
  if (session === undefined) return
  if (session.model === req.model && session.modelProviderId === req.modelProviderId) return
  store.putSession({ ...session, model: req.model, modelProviderId: req.modelProviderId })
  changed({ kind: 'metadata', sessionIds: [session.id], workspaceId: session.workspaceId })
}

/** 一张要搬进新会话的源图:库里那一行的元数据 + 预读好的字节。 */
interface SourceImage {
  displayName: string
  mime: string
  bytes: Uint8Array<ArrayBuffer>
}

/**
 * 把源会话里要搬的托管图片**异步**读进内存,按文件名索引。
 *
 * 需求:分支/复制不能卡住主进程。原先是建好会话之后逐张 `readFileSync` ——
 * 主进程是全部窗口共用的那一个,长会话、图多时表现为点下「分支」后**整个应用**
 * (不只是聊天区)冻住,之前的按钮又没有忙碌态,用户会再点几下,于是建出好几条。
 *
 * 读失败(文件已被清理)不算失败:这张图不进表,`rehomeImageRefs` 会保留原引用。
 * 源会话里它本来就是坏的,分支不比源会话更坏;原先是整个分支跟着失败。
 */
async function readSourceImages(sourceSessionId: string, fileNames: readonly string[]): Promise<Map<string, SourceImage>> {
  const loaded = await Promise.all(fileNames.map(async (fileName): Promise<[string, SourceImage] | null> => {
    const row = store.getAttachmentRowByOwnerAndFileName(sourceSessionId, fileName)
    if (row === undefined) return null
    try {
      const bytes = new Uint8Array(await readFile(row.path))
      return [fileName, { displayName: row.displayName ?? basename(row.path), mime: mimeOfExt(row.path), bytes }]
    } catch {
      return null
    }
  }))
  return new Map(loaded.filter((entry): entry is [string, SourceImage] => entry !== null))
}

/**
 * 建一条新会话,把 `messages` 整段搬进去(含图片附件重新落盘)。
 * `duplicateSession`(整段克隆)和 `branchSession`(只克隆到某一轮为止)共用这一步 ——
 * 两者唯一的差别就是喂给它的 `messages` 切没切。
 *
 * 分两段:先异步读图(慢的 IO 都在这里,见 `readSourceImages`),再**一口气同步**
 * 建会话 + 落附件 + 写转录。
 * ★ 第二段里不许出现 await:会话行一旦建出来,到 `replaceHistory` 之前任何一次让出
 *   事件循环,侧边栏刷新都可能看到一条空的新会话;中途退出还会留下一条空壳。
 */
async function cloneIntoNewSession(sourceSession: Session, title: string, messages: readonly AgentMessage[]): Promise<Session> {
  const sourceSessionId = sourceSession.id
  const images = await readSourceImages(sourceSessionId, ownedImageFileNames(messages, sourceSessionId))

  const sessionId = ulid()
  const session = store.createSession({
    id: sessionId,
    workspaceId: sourceSession.workspaceId,
    title,
    model: sourceSession.model,
    /*
      需求:分支/复制出来的会话沿用源会话的供应商。原先漏了这一项,新会话只剩别名 ——
      正是 `setModel` 上 ★ 说的「新别名 + 旧供应商」那个谁也没配过的组合,
      同名别名挂在多家时会悄悄换到另一家去跑。
    */
    ...(sourceSession.modelProviderId === undefined ? {} : { modelProviderId: sourceSession.modelProviderId }),
    mode: sourceSession.mode,
    thinking: sourceSession.thinking,
    rootPathAtCreation: sourceSession.rootPathAtCreation,
    /*
      需求:复制/分支出来的提炼会话仍是提炼会话 —— 继续追问时 agent 要照样看到源会话摘要。
      不带过去的症状是分支里第一句追问就换来「你要我提炼哪段对话?」。
    */
    ...(sourceSession.skillSource === undefined ? {} : { skillSource: sourceSession.skillSource })
  })
  try {
    /*
      同一张图在转录里出现多次时只落一次盘。`uploadAttachment` 自己也按校验和去重,
      但那要先把整份字节再哈希一遍;这里按文件名记住就够了。
    */
    const moved = new Map<string, string>()
    const rehome = (fileName: string): string | undefined => {
      const done = moved.get(fileName)
      if (done !== undefined) return done
      const image = images.get(fileName)
      if (image === undefined) return undefined
      const url = uploadAttachment({ scope: 'session', ownerId: sessionId, ...image }).url
      moved.set(fileName, url)
      return url
    }
    const cloned = messages.map((message) => ({
      ...rehomeImageRefs(message, sourceSessionId, rehome),
      id: ulid(message.createdAt)
    }))
    store.replaceHistory(sessionId, cloned)
  } catch (error) {
    const paths = store.sessionAttachmentPaths(sessionId)
    store.deleteSession(sessionId)
    removeSessionAttachmentFiles(paths)
    throw error
  }
  changed({ kind: 'metadata', sessionIds: [session.id], workspaceId: sourceSession.workspaceId })
  return session
}

/**
 * 读克隆要的源数据:会话元数据 + 转录。
 * ★ 不走 `getSessionDetail`:那条还会顺带聚合 run 归属、用量和模型三张表,
 *   克隆一样都用不上(新消息 id 全换了,那些归属本来也对不上)。
 */
function cloneSource(sessionId: string): { session: Session; messages: readonly AgentMessage[] } {
  const session = store.getSession(sessionId)
  if (session === undefined) throw new Error(`会话不存在: ${sessionId}`)
  return { session, messages: store.getHistory(sessionId) }
}

/** Clone a transcript into a new session, including managed image attachments. */
export async function duplicateSession(req: { sessionId: string; title: string }): Promise<Session> {
  const source = cloneSource(req.sessionId)
  return cloneIntoNewSession(source.session, req.title, source.messages)
}

/**
 * 进行中的分支请求,键是「源会话 + 切点」。
 *
 * 看起来多余,其实不是:克隆现在是异步的,同一个按钮在第一次还没回来时再被点一下
 * (渲染层有忙碌态,但两个窗口开着同一条会话时各有各的按钮),两次请求会交错着
 * 各建一条一模一样的分支。命中这张表时直接复用第一次的结果。
 */
const pendingBranches = new Map<string, Promise<Session>>()

/**
 * 从某一轮「分支」出一条新会话:只带上到这一轮为止的转录,之后的内容不带过去。
 *
 * `uptoMessageId` 是引出这一轮的**用户提问**消息 id(与 `deleteTurn` 定位同一轮
 * 的方式一致)——一路带到下一条「非纯工具结果」的用户消息之前为止,好让紧跟着
 * 这轮提问之后的工具结果消息也一并带过去。切点算法在 `shared/agent/session-clone.ts`。
 */
export function branchSession(req: { sessionId: string; uptoMessageId: string; title: string }): Promise<Session> {
  const key = `${req.sessionId}\u0000${req.uptoMessageId}`
  const pending = pendingBranches.get(key)
  if (pending !== undefined) return pending
  const task = (async (): Promise<Session> => {
    const source = cloneSource(req.sessionId)
    const end = turnEndIndex(source.messages, req.uptoMessageId)
    if (end === null) throw new Error(`消息不存在: ${req.uptoMessageId}`)
    return cloneIntoNewSession(source.session, req.title, source.messages.slice(0, end))
  })().finally(() => pendingBranches.delete(key))
  pendingBranches.set(key, task)
  return task
}

/**
 * 开一条「从会话提炼 Skill」的会话。
 *
 * 需求:用户把一段做完的业务改动沉淀成项目 Skill(`.next-cowork/skills/<name>/`)。
 * 这里只负责**建会话并记住源会话**;摘要的生成和注入在每个 run 开始时由
 * `runtime.ts` 的 `loadSkillExtraction` 做(源会话之后还可能被追加消息或删掉,快照会过期)。
 *
 * 拒绝全部带 `messageKey`,渲染层直接翻成 toast —— 这几种都是用户能看懂、能自己绕开的原因。
 */
export function createSkillExtractionSession(req: { sourceSessionId: string; title: string }): Session {
  const source = store.getSession(req.sourceSessionId)
  if (source === undefined) throw extractionRefused('skills.extraction.sourceMissing', `会话不存在: ${req.sourceSessionId}`)
  // 子代理转录不是用户的对话,侧边栏里本来也看不到;挡在这里是兜底。
  if (source.parentSessionId !== undefined) throw extractionRefused('skills.extraction.sourceMissing', '子代理会话不能提炼')
  // 「提炼的提炼」只会拿一段写 Skill 的过程去写 Skill,没有业务经验可言。
  if (source.skillSource !== undefined) throw extractionRefused('skills.extraction.nested', '提炼会话不能再次提炼')
  /*
    需求:源会话必须是一个稳定的完成快照。
    不满足会怎样:提炼会话读到的是已提交历史,但源 run 仍可能在继续改同一批文件,
    最后生成的 Skill 可能只记录半套步骤,而两个 Agent 还会同时写同一个工作区。
  */
  if (runs.activeRunIds().some((runId) => {
    // 需求:后台子代理拥有自己的 sessionId;父对话结束不代表业务文件已经停止变化。
    let sessionId = runs.get(runId)?.sessionId
    const seen = new Set<string>()
    while (sessionId !== undefined && !seen.has(sessionId)) {
      if (sessionId === source.id) return true
      seen.add(sessionId)
      sessionId = store.getSession(sessionId)?.parentSessionId
    }
    return false
  })) {
    throw extractionRefused('skills.extraction.sourceRunning', '源会话仍有运行中的 Agent')
  }
  const hasUserTurn = store.getHistory(source.id).some((message) =>
    message.role === 'user' && message.internal !== true && !isToolResultOnly(message))
  if (!hasUserTurn) throw extractionRefused('skills.extraction.sourceEmpty', '源会话还没有任何对话')

  const session = store.createSession({
    id: ulid(),
    workspaceId: source.workspaceId,
    title: req.title,
    model: source.model,
    ...(source.modelProviderId === undefined ? {} : { modelProviderId: source.modelProviderId }),
    // 需要写文件:无论源会话当时在什么模式,提炼会话都在 code 模式下跑。
    mode: 'code',
    thinking: source.thinking,
    rootPathAtCreation: store.getWorkspace(source.workspaceId)?.rootPath ?? source.rootPathAtCreation,
    skillSource: { sessionId: source.id }
  })
  changed({ kind: 'metadata', sessionIds: [session.id], workspaceId: session.workspaceId })
  return session
}

function extractionRefused(messageKey: string, message: string): IpcError {
  return new IpcError('conflict', message, undefined, { messageKey })
}

export function renameSession(req: { sessionId: string; title: string }): void {
  store.tx(() => {
    store.renameSession(req.sessionId, req.title)
    /*
      ★ 用户改过的标题归用户,但这**不是**脱离同步 —— 改个名字不等于编辑转录,
      源侧后续的消息照样该同步进来。所以这里只打一个覆盖标记,让下一轮
      不要用源侧标题把它盖回去。
    */
    for (const mapping of store.findImportMappingsByTarget(req.sessionId, 'session')) {
      store.putImportMapping({
        ...mapping,
        meta: { ...mapping.meta, titleOverridden: true },
        updatedAt: Date.now()
      })
    }
  })
  const session = store.getSession(req.sessionId)!
  windows.emitToAll('sessions:changed', {
    kind: 'metadata', sessionIds: [session.id],
    workspaceId: session.workspaceId, renamed: { sessionId: session.id, title: session.title }
  })
}

export function setArchived(req: { sessionId: string; archived: boolean }): void {
  store.setSessionArchived(req.sessionId, req.archived)
  changed({ kind: 'metadata', sessionIds: [req.sessionId], workspaceId: store.getSession(req.sessionId)?.workspaceId })
}

export function setFavorited(req: { sessionId: string; favorited: boolean }): void {
  store.setSessionFavorited(req.sessionId, req.favorited)
  changed({ kind: 'metadata', sessionIds: [req.sessionId], workspaceId: store.getSession(req.sessionId)?.workspaceId })
}

export function deleteSession(req: { sessionId: string }): void {
  /*
    ★ 只有「正在运行的这个会话自己」能挡住删除,别的会话在跑不算。

    删除是整棵子树级联(子代理转录跟着走),所以运行中的 run 只要落在这棵子树里
    就必须拦 —— 否则那个 run 还在往已删除的 sessionId 上写消息。
    但**别的会话**的 run 和这次删除互不相干:曾经这里是「任何一个 Agent 在跑就全局禁止」,
    表现为 A 会话在跑,B 会话连删都删不掉,用户只能先停下来再删,再手动重启任务。
    渲染层会在删除前先用同样的条件弹警告(见 Sidebar),这里只是兜底,错误信息
    用户最终会在 toast 里看到。
  */
  const activeSessionIds = new Set(
    runs.activeRunIds().map((id) => runs.get(id)?.sessionId).filter((id): id is string => id !== undefined)
  )
  if (runsInDeletionSubtree(req.sessionId, activeSessionIds)) {
    throw new Error('该会话有运行中的 Agent，请先停止任务后再删除')
  }
  // Capture paths before the database cascade removes their rows.  The
  // storage helper re-checks remaining references after deletion, so a file
  // shared by an older/migrated record is never removed prematurely.
  const attachmentPaths = requireSessionAttachmentPaths(req.sessionId)
  const session = store.getSession(req.sessionId)
  const previous = session === undefined ? [] : store.listSessions(session.workspaceId)
  const deletedIndex = previous.findIndex((item) => item.id === req.sessionId)
  const sessionIds = store.deleteSession(req.sessionId)
  for (const sessionId of sessionIds) {
    interactions.cancelGoalProposals(sessionId)
    endGoalSession(sessionId)
  }
  const deleted = new Set(sessionIds)
  const remaining = previous.filter((item) => !deleted.has(item.id))
  const replacement = remaining[Math.min(Math.max(deletedIndex, 0), remaining.length - 1)]
  const physical = removeSessionAttachmentFiles(attachmentPaths)
  if (physical.undeletable.length > 0) {
    console.warn('[sessions] 会话附件未能全部删除:', physical.undeletable)
  }
  changed({ kind: 'deleted', sessionIds, workspaceId: session?.workspaceId,
    ...(replacement === undefined || session === undefined ? {} : {
      replacement: { workspaceId: session.workspaceId, id: replacement.id, title: replacement.title }
    }) })
}

function requireSessionAttachmentPaths(sessionId: string): string[] {
  // Keep SQL out of the handler; the store/repository owns the attachment
  // shape and this small accessor is exposed through the storage boundary.
  return store.sessionAttachmentPaths(sessionId)
}

/**
 * 待删会话的级联子树里是否有正在运行的 run。子代理 run 的 sessionId 是子会话
 * 自己的 id,但删除父会话时会连它一起删掉,所以按 `parentSessionId` 追一层。
 */
function runsInDeletionSubtree(rootSessionId: string, activeSessionIds: ReadonlySet<string>): boolean {
  for (const activeId of activeSessionIds) {
    if (activeId === rootSessionId) return true
    if (store.getSession(activeId)?.parentSessionId === rootSessionId) return true
  }
  return false
}

export function searchAll(req: { q: string; workspaceId?: string; limit: number }) {
  return store.searchSessions(req.q, req.workspaceId, req.limit)
}
