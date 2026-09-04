/**
 * 对话视图 —— 一个内层 chat Tab 的全部内容。
 *
 * 它是 per-session store 的**唯一**消费者:流式文本只让这棵子树重渲染,
 * 不会每来一个 token 就把 Tab 栏和侧边栏也刷一遍(方案 §8)。
 *
 * `startAgentEventPump()` **不在这里** —— 它在 App 根部起一次。
 * 放这儿的话五个 chat Tab 就是五个泵,同一批事件被 apply 五次。
 */
import { useEffect, type ReactNode } from 'react'
import { greetingOf } from '../../../../shared/domain/greeting'
import { hasRun } from '../../../../shared/agent/transcript'
import type { Workspace } from '../../../../shared/domain/workspace'
import { sessionStore } from '../../stores/session'
import { Composer } from './Composer'
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
  const { activeRunId, lastSeq, transcript, queuedInputs, draft, send, stop, setDraft } =
    useSession()
  const providerOf = useModelsStore((s) => s.providerOf)

  const running = activeRunId !== null
  const provider = transcript.model === undefined ? undefined : providerOf(transcript.model)
  const started = hasRun(transcript, running)

  useEffect(() => {
    void useModelsStore.getState().load()
  }, [])

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
      onSend={(text, v) => {
        void send(text, {
          workspaceId: workspace.id,
          depth: 0,
          mode: v.mode,
          thinking: v.thinking,
          webSearch: v.webSearch,
          permissionMode: v.permissionMode,
          model: v.model,
          // 步骤 12 接上 SkillRegistry 后换成 workspace.settings.activeSkillIds
          skillIds: []
        })
      }}
      onStop={stop}
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
        <div className="w-full">{composer}</div>
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

      {composer}
    </div>
  )
}
