/**
 * 对话视图 —— 一个内层 chat Tab 的全部内容。
 *
 * 它是 per-session store 的**唯一**消费者:流式文本只让这棵子树重渲染,
 * 不会每来一个 token 就把 Tab 栏和侧边栏也刷一遍(方案 §8)。
 *
 * `startAgentEventPump()` **不在这里** —— 它在 App 根部起一次。
 * 放这儿的话五个 chat Tab 就是五个泵,同一批事件被 apply 五次。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { greetingOf } from '../../../../shared/domain/greeting'
import { hasRun } from '../../../../shared/agent/transcript'
import type { ContentPart } from '../../../../shared/agent/message'
import type { Attachment } from '../../../../shared/domain/attachment'
import { isImageMime } from '../../../../shared/domain/attachment'
import type { Workspace } from '../../../../shared/domain/workspace'
import { ulid } from '../../../../shared/util/id'
import { listSessionAttachments, pickAttachments, removeAttachment, uploadFile } from '../../services/attachment'
import { sessionStore, resumeQueue } from '../../stores/session'
import { Composer } from './Composer'
import { type TrayItem } from './AttachmentTray'
import { PendingQueue } from './PendingQueue'
import { StatusLine } from './StatusLine'
import { Thread } from './Thread'
import { useModelsStore } from '../../stores/models'

export function ChatView({
  sessionId,
  workspace,
  fallbackModel
}: {
  sessionId: string
  workspace: Workspace
  fallbackModel: string
}): ReactNode {
  const useSession = sessionStore(sessionId)
  const {
    activeRunId,
    lastSeq,
    transcript,
    queuedInputs,
    draft,
    send,
    stop,
    setDraft,
    promoteInput,
    editInput,
    dropInput,
    moveInputToDraft
  } = useSession()
  const providerOf = useModelsStore((s) => s.providerOf)

  const running = activeRunId !== null
  const provider = transcript.model === undefined ? undefined : providerOf(transcript.model)
  const started = hasRun(transcript, running)

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
  // 重试要用原 File,而 TrayItem 是可序列化的展示态,不放 File
  const pendingFiles = useRef(new Map<string, File>())

  // 切会话时清空:附件是**这个会话**的草稿,跟着 draft 走
  useEffect(() => {
    setTray([])
    pendingFiles.current.clear()
  }, [sessionId])

  /*
    重启后恢复草稿附件区 —— 与 draft / 队列的 hydrate 同级。

    ★ **回填必须带守卫**:IPC 往返期间用户可能已经拖了新文件进来。
    无条件 setTray 会用旧快照盖掉刚拖进来的那些 —— 与 session store 里
    `hydrateInput` 那条守卫是同一个理由,也是持久化最常见的翻车方式。

    ★ 已知代价:`displayName` 没有单独落列,重启后退化成 ULID 文件名
    (`01J8X.png`)。修它要给 attachments 表再加一列,而这个退化只影响
    「传了图 → 关掉应用 → 重开」这一条路径上的 chip 文案。
  */
  useEffect(() => {
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
                status: 'done' as const,
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
  }, [sessionId])

  const startUpload = useCallback(
    (key: string, file: File) => {
      setTray((t) =>
        t.map((x) => (x.key === key ? { ...x, status: 'uploading', error: undefined } : x))
      )
      void uploadFile(file, 'session', sessionId)
        .then((a) => {
          setTray((t) => t.map((x) => (x.key === key ? { ...x, status: 'done', attachment: a } : x)))
          pendingFiles.current.delete(key)
        })
        .catch((err: unknown) => {
          // ★ 失败的 chip **保留**并可重试。静默移除的话,用户拖了 5 个
          //   只成功 4 个,他只会以为自己少拖了一个。
          setTray((t) =>
            t.map((x) => (x.key === key ? { ...x, status: 'error', error: String(err) } : x))
          )
        })
    },
    [sessionId]
  )

  const attachFiles = useCallback(
    (files: File[]) => {
      const items = files.map((f) => ({ key: ulid(), name: f.name, file: f }))
      setTray((t) => [
        ...t,
        ...items.map(({ key, name }) => ({ key, name, status: 'uploading' as const }))
      ])
      for (const { key, file } of items) {
        pendingFiles.current.set(key, file)
        startUpload(key, file)
      }
    },
    [startUpload]
  )

  const pickAttachment = useCallback(() => {
    // 走主进程 dialog —— 渲染层不指定路径,回来的已经是落好盘的附件
    void pickAttachments('session', sessionId).then((list) => {
      setTray((t) => [
        ...t,
        ...list.map((a) => ({ key: a.id, name: a.displayName, status: 'done' as const, attachment: a }))
      ])
    })
  }, [sessionId])

  const removeFromTray = useCallback((key: string) => {
    setTray((t) => {
      const target = t.find((x) => x.key === key)
      // 已落盘的要连磁盘一起删 —— 否则它变成一个永远不会被引用的草稿
      if (target?.attachment !== undefined) void removeAttachment(target.attachment.id)
      return t.filter((x) => x.key !== key)
    })
    pendingFiles.current.delete(key)
  }, [])

  const retryUpload = useCallback(
    (key: string) => {
      const file = pendingFiles.current.get(key)
      if (file !== undefined) startUpload(key, file)
    },
    [startUpload]
  )

  /** 托盘 → ContentPart[]。只取已完成的,上传中/失败的不进 parts */
  function partsOf(text: string): ContentPart[] | undefined {
    const ready = tray.filter((x) => x.status === 'done' && x.attachment !== undefined)
    if (ready.length === 0) return undefined
    const parts: ContentPart[] = []
    if (text !== '') parts.push({ type: 'text', text })
    for (const x of ready) {
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
    <Composer
      workspace={workspace}
      fallbackModel={fallbackModel}
      draft={draft}
      onDraft={setDraft}
      running={running}
      attachments={tray}
      onAttachFiles={attachFiles}
      onPickAttachment={pickAttachment}
      onRemoveAttachment={removeFromTray}
      onRetryAttachment={retryUpload}
      onSend={(text, v) => {
        const parts = partsOf(text)
        void send(
          text,
          {
            workspaceId: workspace.id,
            depth: 0,
            mode: v.mode,
            thinking: v.thinking,
            webSearch: v.webSearch,
            permissionMode: v.permissionMode,
            model: v.model,
            /*
              ★ 这里传空数组曾经让整个 Skill 功能在产品里悄悄失效:单测全绿,
              而模型永远看不到任何 Skill。现在传的是工作区的选装清单,
              **空清单在主进程一侧意味着「全都要」**(见 `SkillRegistry.resolve`),
              所以新建的工作区不需要用户先去哪里勾一遍。
            */
            skillIds: workspace.settings.activeSkillIds
          },
          parts
        )
        // ★ 发送后清托盘。附件的所有权已经转移给那条消息 ——
        //   `commitMessage` 会把它们从 draft 升为 committed。
        setTray([])
        pendingFiles.current.clear()
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
      onResume={() => resumeQueue(sessionId)}
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
          {composer}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Thread transcript={transcript} running={running} providerName={provider?.name} />

      <StatusLine
        transcript={transcript}
        running={running}
        lastSeq={lastSeq}
        queued={queuedInputs.length}
      />

      {queue}
      {composer}
    </div>
  )
}
