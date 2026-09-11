/**
 * 对话视图 —— 一个内层 chat Tab 的全部内容。
 *
 * 它是 per-session store 的**唯一**消费者:流式文本只让这棵子树重渲染,
 * 不会每来一个 token 就把 Tab 栏和侧边栏也刷一遍(方案 §8)。
 *
 * `startAgentEventPump()` **不在这里** —— 它在 App 根部起一次。
 * 放这儿的话五个 chat Tab 就是五个泵,同一批事件被 apply 五次。
 */
import { Check, ChevronDown, LoaderCircle, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { greetingOf } from '../../../../shared/domain/greeting'
import { hasRun } from '../../../../shared/agent/transcript'
import { latestTodosFrom, type TodoItem } from '../../../../main/kernel/tool/builtin/todo'
import { useI18n } from '../../i18n'
import type { ContentPart } from '../../../../shared/agent/message'
import type { Attachment, WorkspaceAttachmentIntent } from '../../../../shared/domain/attachment'
import { isLocalEnvironment } from '../../../../shared/domain/environment'
import { isImageMime, mimeOfExt } from '../../../../shared/domain/attachment'
import type { Workspace } from '../../../../shared/domain/workspace'
import { ulid } from '../../../../shared/util/id'
import { cancelWorkspaceUpload, completeWorkspaceUpload, listSessionAttachments, pickAttachments, prepareWorkspaceUpload, removeAttachment, uploadFile } from '../../services/attachment'
import { connectionErrorKey } from '../../services/connections'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { updateWorkspace } from '../../services/app'
import { sessionStore, resumeQueue } from '../../stores/session'
import { Composer, type FallbackModel } from './Composer'
import { type TrayItem } from './AttachmentTray'
import { PendingQueue } from './PendingQueue'
import { Thread } from './Thread'
import { useModelsStore } from '../../stores/models'
import { useTabsStore } from '../../stores/tabs'
import { WorkspaceMarkdownProvider } from '../../components/markdown'
import { createSession } from '../../services/sessions'

export function ChatView({
  sessionId,
  tabId,
  workspace,
  fallbackModel
}: {
  /** null = 还没有会话的草稿 Tab,见 `shared/domain/tab.ts` 的 `chatKey` */
  sessionId: string | null
  tabId: string
  workspace: Workspace
  fallbackModel: FallbackModel
}): ReactNode {
  /*
    ★ 草稿期用 tabId 作键 —— 转录 store 与未发出输入的存档都按它索引。
    这个键**只在渲染层有效**,绝不能往 IPC 上送(理由见 `chatKey` 的注释)。
  */
  const storeKey = sessionId ?? tabId
  const remote = !isLocalEnvironment(workspace.environment)
  const useSession = sessionStore(storeKey)
  const { activeRunId, lastSeq, transcript, queuedInputs, compacting } = useSession(useShallow((state) => ({
    activeRunId: state.activeRunId,
    lastSeq: state.lastSeq,
    transcript: state.transcript,
    queuedInputs: state.queuedInputs,
    compacting: state.compacting
  })))
  const {
    stop,
    promoteInput,
    editInput,
    editMessage,
    deleteTurn,
    dropInput,
    moveInputToDraft,
    retagQueuedPermission,
    retagQueuedMode,
    compactContext
  } = useSession.getState()
  const providerById = useModelsStore((s) => s.providerById)
  // 订阅数组本身而不只是取函数:别名表加载完 / 设置页改完之后抬头要跟着变。
  const models = useModelsStore((s) => s.models)
  const openMarkdownFile = useCallback((path: string) => {
    useTabsStore.getState().openPath(workspace.id, 'doc', path, path.split('/').pop() ?? path)
  }, [workspace.id])

  /**
   * 拿一个**能送进 IPC 的**会话 id —— 草稿在这一刻才铸出它自己的那一个。
   *
   * 附件和发送两条路径都要过它,而且可能先后发生(先贴图再发送),
   * 所以 `bindChatSession` 是幂等的:第二次拿到的还是第一次那个 id。
   * 见 `stores/tabs.ts` 里它的注释 —— 那里写着为什么贴图也必须铸 id。
   */
  const ensureSessionId = useCallback(
    (): string => useTabsStore.getState().bindChatSession(workspace.id, tabId) ?? storeKey,
    [workspace.id, tabId, storeKey]
  )

  const running = activeRunId !== null
  /*
    ★ 直接按回包带回来的 providerId 查,**不再经过别名表**。
    以前是 `providerOf(transcript.model)`,而 `transcript.model` 是上游回包里的
    **真实模型名**、不是别名 —— 那条查询只在「别名恰好等于上游模型名」时才碰巧对,
    用户一改别名就查不到。现在这行说的是既成事实:这段回复实际由哪家给的,
    故障切换真换了家时它跟着变。
  */
  const provider = transcript.providerId === undefined ? undefined : providerById(transcript.providerId)
  /*
    ★ 抬头显示**用户选的那个别名**,不是 `transcript.model`。后者是上游回包里的
    真实模型名(`deepseek-flash`),而用户在药丸上选的、在设置里配的是别名
    (`deepseek-v4.1-flash-exp`)—— 两个名字对不上时,他会以为自己选的模型没生效。
    按 `(providerId, upstreamModel)` 反查这条绑定;查不到(改过配置、或者故障切换
    到一个没配过的模型)才退回真实模型名,那时它是唯一说得清的信息。
  */
  const modelName = transcript.model === undefined
    ? undefined
    : models.find((m) => m.upstreamModel === transcript.model
        && (transcript.providerId === undefined || m.providerId === transcript.providerId))?.alias
      ?? transcript.model
  /** 编辑消息续跑时用的模型。和 `Composer` 的兜底链同源:工作区选过的 → 应用默认。 */
  const editModel: FallbackModel = workspace.settings.defaultModel !== ''
    ? { model: workspace.settings.defaultModel,
        modelProviderId: workspace.settings.defaultModelProviderId }
    : fallbackModel
  const onEditMessage = useCallback((id: string, text: string, continueRun: boolean) => editMessage(id, text, continueRun, {
    workspaceId: workspace.id,
    depth: 0,
    mode: workspace.settings.defaultMode,
    thinking: workspace.settings.defaultThinking,
    webSearch: workspace.settings.webSearch,
    permissionMode: workspace.settings.permissionMode,
    model: editModel.model,
    modelProviderId: editModel.modelProviderId,
    skillIds: workspace.settings.activeSkillIds,
    skillSelectionMode: workspace.settings.skillSelectionMode
  }), [editMessage, editModel.model, editModel.modelProviderId, workspace])
  const started = hasRun(transcript, running)
  const { t } = useI18n()
  const todoToolName = transcript.messages.flatMap((m) => m.parts).find((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call' && p.name.includes('TodoWrite'))?.name
  const todos = todoToolName === undefined ? undefined : latestTodosFrom(transcript.messages, todoToolName)

  /** 批准执行后计划模式已经完成使命 —— 药丸和工作区默认值都要跟着退回普通模式,否则下一句话还得再走一遍只读审批。 */
  const [planExitSignal, setPlanExitSignal] = useState(0)

  const executePlan = useCallback((plan: string, newSession: boolean, planId?: string, planVersion?: number): void => {
    const options = {
      workspaceId: workspace.id,
      depth: 0 as const,
      mode: 'normal' as const,
      thinking: workspace.settings.defaultThinking,
      webSearch: workspace.settings.webSearch,
      permissionMode: workspace.settings.permissionMode,
      model: workspace.settings.defaultModel !== '' ? workspace.settings.defaultModel : fallbackModel.model,
      modelProviderId: workspace.settings.defaultModelProviderId ?? fallbackModel.modelProviderId,
      skillIds: workspace.settings.activeSkillIds,
      skillSelectionMode: workspace.settings.skillSelectionMode
      ,planId
      ,planVersion
    }
    const start = (targetSessionId: string): void => {
      void sessionStore(targetSessionId).getState().send(`Execute the approved plan:\n\n${plan}`, options)
    }
    setPlanExitSignal((v) => v + 1)
    retagQueuedMode('normal')
    if (workspace.settings.defaultMode === 'plan') {
      void updateWorkspace({ id: workspace.id, settings: { defaultMode: 'normal' } }).catch(() => undefined)
    }
    if (!newSession) { start(ensureSessionId()); return }
    void createSession(workspace.id, t('composer.planExecutionTitle')).then((session) => {
      useTabsStore.getState().openSession(workspace.id, session.id, session.title)
      start(session.id)
    }).catch(() => undefined)
  }, [ensureSessionId, fallbackModel.model, fallbackModel.modelProviderId, retagQueuedMode, t, workspace])

  useEffect(() => {
    void useModelsStore.getState().load()
  }, [])

  /*
    ★ **草稿附件住在这里,与 draft 同级** —— 因为发送时要把它们转成
    `ContentPart[]`,而「什么进 RunRequest」是这一层的职责,不是输入框的。

    托盘项的身份是本地 mint 的 `key` 而不是附件 id:上传是异步的,
    chip 必须在拿到 `Attachment` **之前**就存在,否则拖进 5 个文件时
    界面会空着直到第一个传完。
  */
  const [tray, setTray] = useState<TrayItem[]>([])
  const [uploadIntent, setUploadIntent] = useState<{ key: string; intent: WorkspaceAttachmentIntent } | null>(null)
  const [transferring, setTransferring] = useState(false)
  const uploadTicket = useRef<string | null>(null)
  const uploadVersion = useRef(0)
  useEffect(() => () => {
    uploadVersion.current++
    if (uploadTicket.current) void cancelWorkspaceUpload(uploadTicket.current).catch(() => {})
    uploadTicket.current = null
  }, [workspace.id, storeKey])
  // 重试要用原 File,而 TrayItem 是可序列化的展示态,不放 File
  const pendingFiles = useRef(new Map<string, File>())

  // 切会话时清空:附件是**这个会话**的草稿,跟着 draft 走
  useEffect(() => {
    setTray([])
    pendingFiles.current.clear()
  }, [storeKey])

  /*
    重启后恢复草稿附件区 —— 与 draft / 队列的 hydrate 同级。

    ★ **回填必须带守卫**:IPC 往返期间用户可能已经拖了新文件进来。
    无条件 setTray 会用旧快照盖掉刚拖进来的那些 —— 与 session store 里
    `hydrateInput` 那条守卫是同一个理由,也是持久化最常见的翻车方式。

    ★ 已知代价:`displayName` 没有单独落列,重启后退化成 ULID 文件名
    (`01J8X.png`)。修它要给 attachments 表再加一列,而这个退化只影响
    「传了图 → 关掉应用 → 重开」这一条路径上的 chip 文案。

    ★ 非图片的路径型托盘项**不在这份存档里**——它们从没上传过,`listSessionAttachments`
    自然查不到。重启后这些 chip 会丢,代价与上面那条同级:只影响「拖了非图片文件 →
    关掉应用 → 重开」这一条冷门路径。
  */
  useEffect(() => {
    // 草稿还没铸出 id 就不可能有存档 —— 拿 tabId 去问只会得到「会话不存在」
    if (sessionId === null) return
    let cancelled = false
    void listSessionAttachments(sessionId)
      .then((list) => {
        if (cancelled || list.length === 0) return
        setTray((t) =>
          t.length > 0
            ? t
            : list.map((a) => ({
                key: a.id,
                name: a.displayName,
                status: remote && !isImageMime(a.mime) ? 'awaiting-upload' as const : 'done' as const,
                attachment: a
              }))
        )
      })
      .catch((err: unknown) => {
        // 恢复失败不该拦住会话可用 —— 最坏结果是少一批草稿附件
        console.error('[attachment] 恢复草稿附件失败:', err)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, remote])

  const startUpload = useCallback(
    (key: string, file: File) => {
      setTray((t) =>
        t.map((x) => (x.key === key ? { ...x, status: 'uploading', error: undefined } : x))
      )
      void uploadFile(file, 'session', ensureSessionId())
        .then((a) => {
          setTray((t) => t.map((x) => (x.key === key ? { ...x, status: remote && !isImageMime(a.mime) ? 'awaiting-upload' : 'done', attachment: a } : x)))
          pendingFiles.current.delete(key)
        })
        .catch(() => {
          // ★ 失败的 chip **保留**并可重试。静默移除的话,用户拖了 5 个
          //   只成功 4 个,他只会以为自己少拖了一个。
          setTray((current) =>
            current.map((x) => (x.key === key ? { ...x, status: 'error', error: t('ssh.attachmentFailed') } : x))
          )
        })
    },
    [ensureSessionId, remote, t]
  )

  /*
    ★ 图片走原有的上传流程(要内联展示,协议直供);非图片**不落盘**——
    上传一份没人会去读的字节副本没有意义。这个应用本身就是个带文件系统工具的
    Agent,给它真实路径,它自己会用 Read 之类的工具去看,比塞一份复制品有用得多。
  */
  const attachFiles = useCallback(
    (files: File[]) => {
      const items = files.map((f) => ({
        key: ulid(),
        name: f.name,
        file: f,
        isImage: isImageMime(f.type !== '' ? f.type : mimeOfExt(f.name))
      }))
      setTray((t) => [
        ...t,
        ...items.map(({ key, name, isImage, file }) =>
          isImage || remote
            ? { key, name, status: 'uploading' as const }
            : pathTrayItem(key, name, file)
        )
      ])
      for (const { key, file, isImage } of items) {
        if (!isImage && !remote) continue
        pendingFiles.current.set(key, file)
        startUpload(key, file)
      }
    },
    [startUpload, remote]
  )

  /**
   * 非图片文件的托盘项:同步取真实路径,不经过 IPC 上传。
   * ★ 拿不到路径(比如某些合成的剪贴板文件)时直接标错误,不放进 pendingFiles ——
   * 这不是网络失败,重试也不会有不同结果。
   */
  function pathTrayItem(key: string, name: string, file: File): TrayItem {
    const path = window.nextcowork.getPathForFile(file)
    return path === ''
      ? { key, name, status: 'error', error: t('chat.pathUnavailable') }
      : { key, name, status: 'done', path, source: { kind: 'local' } }
  }

  /**
   * 菜单里的「添加附件」。★ **落进托盘的东西与拖拽/粘贴完全同形** ——
   * 图片是落好盘的 `attachment`,非图片是一条 `path`。分流本身在主进程做
   * (只有它拿得到 dialog 选中的真实路径),这里只是把两种形态摊成 chip。
   */
  const pickAttachment = useCallback(() => {
    // 走主进程 dialog —— 渲染层不指定路径,路径是用户在系统对话框里选定的
    void pickAttachments('session', ensureSessionId(), remote).then((list) => {
      setTray((current) => [
        ...current,
        ...list.map((p) =>
          p.kind === 'path'
            ? // key 只是 chip 的本地身份,路径型的没有附件 id 可用
              (remote ? { key: ulid(), name: p.name, status: 'error' as const, error: t('ssh.attachmentFailed') } : { key: ulid(), name: p.name, status: 'done' as const, path: p.path, source: { kind: 'local' as const } })
            : {
                key: p.attachment.id,
                name: p.attachment.displayName,
                status: remote && !isImageMime(p.attachment.mime) ? 'awaiting-upload' as const : 'done' as const,
                attachment: p.attachment
              }
        )
      ])
    })
  }, [ensureSessionId, remote, t])

  const removeFromTray = useCallback((key: string) => {
    setTray((t) => {
      const target = t.find((x) => x.key === key)
      // 已落盘的要连磁盘一起删 —— 否则它变成一个永远不会被引用的草稿
      if (target?.attachment !== undefined) void removeAttachment(target.attachment.id)
      return t.filter((x) => x.key !== key)
    })
    pendingFiles.current.delete(key)
  }, [])

  const cancelTransfer = (): void => {
    uploadVersion.current++
    if (uploadTicket.current) void cancelWorkspaceUpload(uploadTicket.current).catch(() => {})
    uploadTicket.current = null
    if (uploadIntent) setTray((items) => items.map((item) => item.key === uploadIntent.key ? { ...item, status: 'awaiting-upload' } : item))
    setUploadIntent(null)
    setTransferring(false)
  }

  const retryUpload = (key: string): void => {
    const item = tray.find((entry) => entry.key === key)
    if (remote && item?.attachment && !isImageMime(item.attachment.mime)) {
      if (transferring) return
      const version = ++uploadVersion.current
      if (uploadTicket.current) void cancelWorkspaceUpload(uploadTicket.current).catch(() => {})
      setTransferring(true)
      void prepareWorkspaceUpload(item.attachment.id, ensureSessionId(), workspace.id).then((intent) => {
        if (version !== uploadVersion.current) { void cancelWorkspaceUpload(intent.ticket).catch(() => {}); return }
        uploadTicket.current = intent.ticket
        setUploadIntent({ key, intent })
      }).catch((error: unknown) => {
        if (version === uploadVersion.current) setTray((items) => items.map((entry) => entry.key === key ? { ...entry, status: 'error', error: t(connectionErrorKey(error)) } : entry))
      }).finally(() => { if (version === uploadVersion.current) setTransferring(false) })
      return
    }
    const file = pendingFiles.current.get(key)
    if (file !== undefined) startUpload(key, file)
  }

  const confirmTransfer = (): void => {
    if (!uploadIntent || transferring) return
    const { key, intent } = uploadIntent
    const version = uploadVersion.current
    setTransferring(true)
    setTray((items) => items.map((item) => item.key === key ? { ...item, status: 'uploading' } : item))
    void completeWorkspaceUpload(intent.ticket).then((reference) => {
      if (version !== uploadVersion.current) return
      setTray((items) => items.map((item) => item.key === key ? { ...item, ...reference, status: 'done', attachment: undefined } : item))
      void removeAttachment(intent.attachmentId).catch(() => {})
    }).catch((error: unknown) => {
      if (version === uploadVersion.current) setTray((items) => items.map((item) => item.key === key ? { ...item, status: 'error', error: t(connectionErrorKey(error)) } : item))
    }).finally(() => {
      if (version === uploadVersion.current) { uploadTicket.current = null; setUploadIntent(null); setTransferring(false) }
    })
  }

  const transferDialog = <Dialog open={uploadIntent !== null} title={t('ssh.uploadToServer')} onClose={() => { if (!transferring) cancelTransfer() }} footer={<>
    <Button variant="ghost" disabled={transferring} onClick={cancelTransfer}>{t('common.cancel')}</Button>
    <Button disabled={transferring} onClick={confirmTransfer}><Upload size={14} />{t(transferring ? 'chat.uploading' : 'ssh.uploadToServer')}</Button>
  </>}>
    {uploadIntent && <dl className="space-y-3 break-words text-[13px]">
      <div><dt className="text-fg-muted">{t('ssh.uploadSource')}</dt><dd>{uploadIntent.intent.name}</dd></div>
      <div><dt className="text-fg-muted">{t('ssh.uploadDestination')}</dt><dd>{uploadIntent.intent.connectionName}</dd><dd className="font-mono text-[12px]">{uploadIntent.intent.directory}</dd></div>
    </dl>}
  </Dialog>

  /** 托盘 → ContentPart[]。只取已完成的,上传中/失败的不进 parts */
  function partsOf(text: string): ContentPart[] | undefined {
    const ready = tray.filter((x) => x.status === 'done' && (x.attachment !== undefined || x.path !== undefined))
    if (ready.length === 0) return undefined
    const parts: ContentPart[] = []
    if (text !== '') parts.push({ type: 'text', text })
    for (const x of ready) {
      if (x.path !== undefined) {
        if (remote && (x.source?.kind !== 'workspace' || x.source.workspaceId !== workspace.id)) continue
        parts.push({ type: 'file_ref', path: x.path, name: x.name, source: x.source })
        continue
      }
      const a = x.attachment as Attachment
      if (isImageMime(a.mime)) parts.push({ type: 'image', mime: a.mime, dataRef: a.url })
      else parts.push({ type: 'text', text: `[附件] ${a.displayName}` })
    }
    return parts
  }

  // 两种布局共用同一个输入框实例的**写法**,但注意它们是两棵不同的子树 ——
  // 从空态切到有内容时 React 会重新挂载它。这没问题:草稿在 session store 里,
  // 而发出去的那一刻草稿已经清空了。
  const composer = (
    <SessionComposer
      storeKey={storeKey}
      workspace={workspace}
      fallbackModel={fallbackModel}
      onPermissionModeChange={retagQueuedPermission}
      running={running}
      planExitSignal={planExitSignal}
      attachments={tray}
      onAttachFiles={attachFiles}
      onPickAttachment={pickAttachment}
      onRemoveAttachment={removeFromTray}
      onRetryAttachment={retryUpload}
      contextTokens={transcript.lastInputTokens}
      contextCompacting={compacting}
      onCompactContext={compactContext}
      onSend={(text, v) => {
        const parts = partsOf(text)
        /*
          ★ **先铸 id,再对那个 id 的 store 发送。**

          草稿这一刻才变成一段会话。绑定会改 `tab.ref.sessionId` → `registry.tsx`
          的 key 跟着 `chatKey` 变 → 本组件立刻被卸载重挂。所以:
          - 清托盘放在 `send` **之前**(卸载之后再 setState 是无效更新);
          - `send` 不能 await —— await 之后的代码属于一棵已经不存在的树。
          重挂出来的那一个从新键的 store 里读,而乐观插入的用户消息已经在里面了。
        */
        setTray((items) => items.filter((item) => item.status !== 'done'))
        pendingFiles.current.clear()
        void sessionStore(ensureSessionId()).getState().send(
          text,
          {
            workspaceId: workspace.id,
            depth: 0,
            mode: v.mode,
            thinking: v.thinking,
            webSearch: v.webSearch,
            permissionMode: v.permissionMode,
            model: v.model,
            modelProviderId: v.modelProviderId,
            /*
              ★ 这里传空数组曾经让整个 Skill 功能在产品里悄悄失效:单测全绿,
              而模型永远看不到任何 Skill。现在传的是工作区的选装清单,
              **空清单在主进程一侧意味着「全都要」**(见 `SkillRegistry.resolve`),
              所以新建的工作区不需要用户先去哪里勾一遍。
            */
            skillIds: workspace.settings.activeSkillIds
            ,skillSelectionMode: workspace.settings.skillSelectionMode
          },
          parts
        )
      }}
      onStop={stop}
    />
  )

  /*
    ★ **队列区跟着输入框走,不跟着转录走。** 它属于「还没发出去的东西」那一侧,
    所以空态和常驻态两棵子树都要有它 —— 用户在空会话里连发两条同样会排队。
  */
  const queue = (
    <PendingQueue
      items={queuedInputs}
      running={running}
      onPromote={promoteInput}
      onEdit={editInput}
      onDrop={dropInput}
      onMoveToDraft={moveInputToDraft}
      onResume={() => resumeQueue(storeKey)}
    />
  )

  /*
    ★ **空会话不是「一个空的对话界面」,是另一屏。**
    参考实现(截图 c6184031)在这一屏把问候语和输入框**竖直居中**,没有空状态插画、
    没有状态行、输入框也不贴底。贴底的输入框加一张居中插画,看起来像是内容没加载出来。
    第一条消息发出去之后才切成「转录在上、输入框在下」的常驻布局。
  */
  if (!started) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-10">
        <h1 className="mb-6 px-6 text-center text-[26px] leading-snug font-semibold text-fg">
          {greetingOf(new Date().getHours())}
        </h1>
        <div className="w-full">
          {queue}
          {todos !== undefined && <TaskChecklist todos={todos} t={t} />}
          {composer}
          {transferDialog}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceMarkdownProvider workspaceId={workspace.id} workspaceRoot={workspace.rootPath} onOpenFile={openMarkdownFile}>
        <Thread
          sessionId={sessionId ?? undefined}
          transcript={transcript}
          runId={activeRunId}
          model={modelName}
          providerName={provider?.name}
          lastSeq={lastSeq}
          queued={queuedInputs.length}
          onEditMessage={onEditMessage}
          onDeleteTurn={deleteTurn}
          onExecutePlan={executePlan}
        />
      </WorkspaceMarkdownProvider>

      {queue}
      {todos !== undefined && <TaskChecklist todos={todos} t={t} />}
      {composer}
      {transferDialog}
    </div>
  )
}

function SessionComposer({ storeKey, ...props }: { storeKey: string } & Omit<ComponentProps<typeof Composer>, 'draft' | 'onDraft'>): ReactNode {
  const useSession = sessionStore(storeKey)
  const draft = useSession((state) => state.draft)
  const setDraft = useSession((state) => state.setDraft)
  return <Composer {...props} draft={draft} onDraft={setDraft} />
}

/**
 * 输入框上方的任务清单。默认折叠 —— 展开态会顶掉输入框上方的空间,而清单标题行
 * 里已经带了「已完成 x/y」、当前进行项和进度条,不展开也够看。想看全部再点开。
 */
function TaskChecklist({ todos, t }: { todos: readonly TodoItem[]; t: ReturnType<typeof useI18n>['t'] }): ReactNode {
  const [collapsed, setCollapsed] = useState(true)
  const done = todos.filter((item) => item.status === 'completed').length
  const active = todos.find((item) => item.status === 'in_progress')
  const progress = todos.length === 0 ? 0 : done / todos.length
  return <div className="mx-auto w-full max-w-[760px] px-6 pb-2" data-testid="task-checklist"><div className="rounded-panel border border-border bg-surface/60 px-3 py-2"><button type="button" aria-expanded={!collapsed} aria-controls="task-checklist-items" className="flex w-full min-w-0 items-center gap-1.5 text-left text-[12px] font-medium text-fg" onClick={() => setCollapsed((value) => !value)}><ChevronDown size={13} className={`shrink-0 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} /><span className="shrink-0">{t('chat.taskChecklist', { done, total: todos.length })}</span>{active !== undefined && <span className="ml-1 min-w-0 truncate font-normal text-fg-muted">· {active.activeForm}</span>}{active !== undefined && <LoaderCircle size={12} aria-label={t('chat.taskChecklistRunning')} className="ml-auto shrink-0 animate-spin text-accent motion-reduce:animate-none" />}{collapsed && <span className="ml-auto flex shrink-0 items-center gap-1.5"><span className="h-1.5 w-16 overflow-hidden rounded-pill bg-tint"><span className="block h-full rounded-pill bg-accent transition-[width] duration-500" style={{ width: `${progress * 100}%` }} /></span><span className="text-[10px] text-fg-faint">{Math.round(progress * 100)}%</span></span>}</button><div id="task-checklist-items" className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}><div className="min-h-0 overflow-hidden"><ul className="scroll-thin mt-1.5 max-h-32 overflow-y-auto pl-5">{todos.map((item, i) => <li key={`${i}:${item.content}`} className={`flex gap-1.5 text-[12px] leading-relaxed ${item.status === 'completed' ? 'text-fg-faint line-through' : item.status === 'in_progress' ? 'text-fg' : 'text-fg-muted'}`}><span className="shrink-0 font-mono">{item.status === 'completed' ? <Check size={12} aria-hidden /> : item.status === 'in_progress' ? <LoaderCircle size={12} className="animate-spin text-accent motion-reduce:animate-none" /> : '○'}</span><span>{item.status === 'in_progress' ? item.activeForm : item.content}</span></li>)}</ul></div></div></div></div>
}
