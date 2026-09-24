/**
 * 输入框上方的 agent 任务清单。
 *
 * 需求：把 TodoWrite 的真实状态画成紧凑的 Task Rows；这里故意不自带演示计时器，
 * 状态只能由转录数据驱动，否则失败或完成会在界面上被动画伪造。
 *
 * 「这份清单此刻还是不是活的」由调用方用 `execution` 表态(见它的注释)——
 * 组件自己**推不出来**:转录里同样是 `in_progress` 的一项,既可能正被这一轮推着走,
 * 也可能是上一轮留下的死账。推不出来的东西不许在这里猜。
 *
 * 折叠态默认收起(见 `defaultCollapsed`):输入框上方那条只在标题行报数,展开列表得由
 * 用户点开 —— 它占了正文上方一整块,默认展开会在每次 TodoWrite 落地时把转录往下顶一屏。
 * 调用方要默认展开时显式表态(原先工具卡片详情就是这么做的;那个位置现在换成了
 * `TodoWriteChecklist`,它自带一套「增量 + 完整清单」的标题行)。
 *
 * ★ **一张清单组件,两种标题行。** 输入框上方那条画进度环 + 计数 + 百分比;消息里那张
 * TodoWrite 卡片画「这次更新改了什么」+ 完整清单(见 `TodoWriteChecklist.tsx`)。
 * 列表本体(行怎么画、收起时怎么隐藏)只在这里实现一次 —— 两份长得一样的清单
 * 在同一屏里上下相邻,改一处漏一处一眼就能看出来。
 */
import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { Spinner } from '../../components/ui/Spinner'
import { cn } from '../../lib/cn'
import { useIdleMinimize } from './useIdleMinimize'

/**
 * 输入框上方那条收起后多久没人碰就缩成小球。
 * 取 15s:读完标题行那一眼远用不了这么久;再短的话,用户正盯着进度看、
 * 鼠标却不在它上面时(这是常态),它会在眼皮底下缩走。
 */
export const TASK_CHECKLIST_IDLE_MINIMIZE_MS = 15_000

/**
 * 清单里的一项。导出是因为**工具卡片的详情区也渲染这张清单**
 * (见 `todo-preview.ts`):两处共用一个类型,字段变了两边一起编译期报错。
 */
export type TaskChecklistItem = {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * 这份清单和「正在跑的那一轮」的关系。**它只决定展示,永远不改写任务本身** ——
 * item 的 `status` 与「已完成 N/M」这两个数照抄 TodoWrite,任何一档都不重算。
 *
 * - `running`:本轮真的写成功过清单,它还在被推进 —— 允许显示 activeForm 与 Spinner。
 * - `stopped`:清单所属的本轮已经收尾 —— 未完的项按「未完成」陈列,并报出剩余条数。
 * - `snapshot`:这份清单只是转录里的历史快照(工具卡片的入参预览、上一轮留下的),
 *   不代表现在还有谁在跑它。
 */
export type TaskChecklistExecution = 'running' | 'stopped' | 'snapshot'

/**
 * 折叠壳:标题行(由调用方画)+ 可收起的列表。**折叠语义只在这里实现一次** ——
 * `aria-expanded` / `aria-controls` / `inert` 三件套漏掉任何一件,屏读器都会读到
 * 一份「已经收起来却仍然可聚焦」的清单,而屏幕上看不出任何异常。
 */
export function TaskChecklistShell({
  header,
  list,
  defaultCollapsed,
  idleMinimize,
  className
}: {
  /**
   * 标题行。必须自己渲染那颗开合按钮,并接上给回来的 `toggle` / `collapsed` /
   * `listId` —— `aria-controls` 指向的正是下面那个可收起容器。
   */
  header: (props: { toggle: () => void; collapsed: boolean; listId: string }) => ReactNode
  list: ReactNode
  defaultCollapsed: boolean
  /**
   * 收起后长时间无操作就缩成最左边一颗小球(计时规则见 `useIdleMinimize.ts`)。
   * 缺省 = 永不缩:消息里那张 TodoWrite 卡片是转录的一部分,缩掉它等于改写历史的版式。
   * `ball` 画那颗球,必须把给回来的 `restore` 接到它的点击上。
   */
  idleMinimize?: { afterMs: number; ball: (restore: () => void) => ReactNode }
  className?: string
}): ReactNode {
  const listId = useId()
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const { minimized, restore, bindings } = useIdleMinimize({
    enabled: idleMinimize !== undefined && collapsed,
    afterMs: idleMinimize?.afterMs ?? 0
  })
  const cardRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)
  /*
    需求:点小球恢复后焦点落回标题行那颗开合按钮。小球在恢复的同一次提交里被卸载,
    不接住的话焦点掉回 body —— 键盘用户按 Enter 恢复后得从页首重新 Tab 一遍。
    只在「刚从小球恢复」时做:首次挂载就抢焦点会打断用户正在输入框里打的字。
  */
  useEffect(() => {
    if (minimized || !restoredRef.current) return
    restoredRef.current = false
    cardRef.current?.querySelector<HTMLElement>(`[aria-controls="${listId}"]`)?.focus()
  }, [minimized, listId])
  /*
    需求:点小球是「我现在要看这份清单」,所以一次点击直接把列表完全展开 ——
    原先只恢复成收起的标题行,用户必须再点一次才看得到内容,而那一行本身就是
    他刚才没在看、才被缩走的东西。
    ★ 因此这里**顺带清掉 collapsed**:`enabled` 依赖 `collapsed`,展开后计时器
    自然停掉,不会在用户正读清单时又缩走。用户主动收起后,该计时器照旧恢复。
  */
  const restoreFromBall = useCallback(() => {
    restoredRef.current = true
    setCollapsed(false)
    restore()
  }, [restore])
  const outerClassName = cn('mx-auto w-full max-w-[760px] px-6 pb-2', className)

  /*
    ★ 缩成小球时只换掉卡片这一层 DOM,Shell 自己不卸载:`collapsed` 留在这里,
    恢复后不用重建组件就能决定展开还是收起。原先的语义是「恢复出来仍是缩之前
    那一行(必然收起)」;现在点球即完全展开(见 `restoreFromBall`),而「状态住在
    Shell 里」这条理由不变 —— 展开态是由这里的 setState 改出来的。
  */
  if (idleMinimize !== undefined && minimized) {
    return <div className={outerClassName}>{idleMinimize.ball(restoreFromBall)}</div>
  }

  return (
    <div className={outerClassName}>
      <div
        ref={cardRef}
        {...(idleMinimize === undefined ? {} : bindings)}
        className="overflow-hidden rounded-card border border-stroke bg-surface-raised/70"
      >
        {header({ toggle: () => setCollapsed((value) => !value), collapsed, listId })}
        <div
          id={listId}
          aria-hidden={collapsed}
          inert={collapsed}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">{list}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * 清单行 —— 两份清单共用的那一段。
 *
 * `isActive` 说的是**此刻有没有人在推进这份清单**(不是转录里某一项的 status):
 * 见 `TaskChecklist` 里 `execution` 的说明。`highlight` 是「这一项在本次更新里变了」
 * (消息里那张卡片用),它只加一层极浅的底色,不改文字也不改状态。
 */
export function TaskChecklistRows({
  todos,
  isActive,
  highlight
}: {
  todos: readonly TaskChecklistItem[]
  isActive: boolean
  /** 内容 → 是否标为「本次更新动了它」。缺省 = 一个都不标。 */
  highlight?: ReadonlySet<string>
}): ReactNode {
  const { t } = useI18n()
  return (
    <ul className="scroll-thin max-h-40 overflow-y-auto border-t border-hairline px-1 py-1">
      {todos.map((item, index) => {
        /*
          需求:一行到底显示 `activeForm`(「正在更新 UI」)还是 `content`(「更新 UI」),
          取决于**此刻有没有人在做这一项**,而不是转录里它的 status 是什么。
          快照/已收尾时显示 activeForm 等于把过去式说成现在进行时。
        */
        const showActive = isActive && item.status === 'in_progress'
        const label = showActive ? item.activeForm : item.content
        // sr-only 里的状态词同理:没人在做的那一项,屏读器不能听到「任务正在执行」
        const statusLabel = item.status === 'completed'
          ? t('chat.status.done')
          : showActive
            ? t('chat.taskChecklistRunning')
            : item.status === 'in_progress'
              ? t('chat.taskChecklist.unfinished')
              : t('chat.tool.waitingStatus')
        return (
          <li
            key={`${String(index)}:${item.content}`}
            // 始终是转录里的原值:档位只改怎么画,不改这一项究竟是什么状态
            data-task-status={item.status}
            className={cn(
              'flex min-h-8 items-center gap-2 rounded-[7px] px-1.5 py-1 text-[12px]',
              showActive && 'bg-accent/[0.045]',
              highlight?.has(item.content) === true && 'bg-tint-hover/50'
            )}
          >
            <span className="relative flex size-5 shrink-0 items-center justify-center" aria-hidden>
              {item.status === 'completed' ? (
                <span className="flex size-5 items-center justify-center rounded-pill bg-accent text-accent-fg">
                  <Check size={11} strokeWidth={3} />
                </span>
              ) : showActive ? (
                // Spinner 负责应用内“减弱/关闭动效”两档，不能退回裸 CSS 旋转。
                <Spinner size="sm" className="text-accent" />
              ) : (
                <span className="flex size-5 items-center justify-center rounded-pill border border-stroke text-[9px] tabular-nums text-fg-faint">
                  {index + 1}
                </span>
              )}
            </span>
            <span className={cn(
              'min-w-0 flex-1 break-words leading-relaxed',
              item.status === 'completed' ? 'text-fg-faint' : item.status === 'in_progress' ? 'text-fg' : 'text-fg-muted'
            )}>
              {label}
            </span>
            <span className="sr-only">{statusLabel}</span>
          </li>
        )
      })}
    </ul>
  )
}

export function TaskChecklist({
  todos,
  execution = 'snapshot',
  defaultCollapsed = true,
  minimizeWhenIdle = true,
  className
}: {
  /** TodoWrite 的当前完整快照；顺序由 agent 决定，组件只负责展示。 */
  todos: readonly TaskChecklistItem[]
  /**
   * 这份清单此刻还算不算「正在跑」。
   *
   * 需求:同一份转录数据会出现在两个位置 —— 输入框上方那条要看得出现在推进到哪,
   * 而工具卡片详情里那份是历史/入参快照(见 `todo-preview.ts`),它既不该转圈,
   * 也不该说「现在正在做」。
   * ★ 缺省是 `snapshot`,即**保守的那一侧**:调用方不表态时宁可不显示进度,
   *   也不能伪造一个「还在跑」的界面 —— 后者会让人一直等一个不会来的结果。
   */
  execution?: TaskChecklistExecution
  /**
   * 首次挂载时是否收着列表。
   *
   * 需求:同一个组件出现在两处,而两处对「默认展开」的答案不同 —— 输入框上方那条
   * 占了正文上方一整块,默认展开会在每次 TodoWrite 落地时把转录往下顶一屏;
   * 而用户主动展开卡片来读的那个位置希望直接看到内容。
   * 默认值取收起的一侧,新增调用方不用为「输入框上方」这个最常见的位置再表态一次。
   *
   * ★ 这是**挂载时的初值**,不是受控 prop:挂载之后归 `collapsed` 自己,否则
   *   ChatView 每收到一条流式事件重渲一次,用户刚点开的列表就会被按回默认态。
   *   同理,输入框上方那条要**跨 TodoWrite 更新**记住用户的展开意图 ——
   *   那一处的调用方不给 `key`,组件实例因此不会被重建(见 ChatView)。
   */
  defaultCollapsed?: boolean
  /**
   * 收起后 `TASK_CHECKLIST_IDLE_MINIMIZE_MS` 无操作就缩成最左边一颗进度球,点击直接展开完整清单。
   *
   * 需求:收起的那一行仍夹在正文与输入框之间,用户不看它时它该把这一行让出来。
   * 默认开,理由同 `defaultCollapsed`:缺省值服务「输入框上方」这个最常见的位置;
   * 嵌进别处(卡片详情之类)的调用方传 `false`。
   */
  minimizeWhenIdle?: boolean
  /**
   * 外层定位的覆盖位。默认那套(居中、760 上限、左右留白)是**输入框上方**那个
   * 位置的需求;嵌在工具卡片详情里时由调用方传 `max-w-none px-0 pb-0` 抹掉 ——
   * 卡片本体不因此分叉出第二套版式。
   */
  className?: string
}): ReactNode {
  const { t } = useI18n()
  const done = todos.filter((item) => item.status === 'completed').length
  const active = todos.find((item) => item.status === 'in_progress')
  const progress = todos.length === 0 ? 0 : done / todos.length
  /*
    只有 `running` 才谈得上「正在做」。其余两档里 `in_progress` 是**转录留下的一个
    事实**——那一项当年确实开着,但此刻没有人在推进它,所以不转圈、不高亮、不报
    「任务正在执行」,而是按「未完成」陈列。
  */
  const isActive = execution === 'running'
  /*
    需求:小球上放不下第二行那句「仍有 N 项未完成」,但这句不能因为缩起来就丢 ——
    否则停在半截的进度环看起来像还在跑(理由见标题行那段)。所以球角挂一个警示点,
    完整句子进无障碍标签和 title。判据与标题行那段同一条。
  */
  const unfinishedAfterStop = execution === 'stopped' && todos.length - done > 0
  const ballLabel = [
    t('chat.taskChecklist.restore', { done, total: todos.length }),
    ...(unfinishedAfterStop ? [t('chat.taskChecklist.stoppedIncomplete', { count: todos.length - done })] : [])
  ].join(' · ')

  return (
    <div
      // 机器可读的档位:e2e/测试读它,而不是去正则第二行那句会改的文案
      data-testid="task-checklist"
      data-execution-state={execution}
    >
      <TaskChecklistShell
        defaultCollapsed={defaultCollapsed}
        className={className}
        {...(minimizeWhenIdle ? {
          idleMinimize: {
            afterMs: TASK_CHECKLIST_IDLE_MINIMIZE_MS,
            ball: (restore: () => void) => (
              <button
                type="button"
                data-testid="task-checklist-ball"
                aria-label={ballLabel}
                title={ballLabel}
                onClick={restore}
                className={cn(
                  'relative flex size-9 items-center justify-center rounded-pill border border-stroke bg-surface-raised/70',
                  'transition-[opacity,scale,background-color] duration-200 ease-out hover:bg-tint-hover',
                  'starting:scale-50 starting:opacity-0 motion-reduce:transition-none'
                )}
              >
                <ProgressRing progress={progress} done={done} />
                {unfinishedAfterStop && (
                  <span aria-hidden className="absolute top-0 right-0 size-2 rounded-pill bg-warning" />
                )}
              </button>
            )
          }
        } : {})}
        list={<TaskChecklistRows todos={todos} isActive={isActive} />}
        header={({ toggle, collapsed, listId }) => (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={listId}
            className="flex h-11 w-full min-w-0 items-center gap-2.5 px-2.5 text-left"
            onClick={toggle}
          >
            <ProgressRing progress={progress} done={done} />

            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-fg">
                {t('chat.taskChecklist', { done, total: todos.length })}
              </span>
              {isActive && active !== undefined && (
                <span className="mt-0.5 block truncate text-[11px] text-fg-muted">{active.activeForm}</span>
              )}
              {/*
                需求:这一轮已经收尾、清单却没跑完,必须说出来 —— 否则第二行空着、进度环
                停在一半,面板看起来仍然是「在跑」,用户会去等一个已经不会发生的结果。
                ★ `todos.length - done > 0` 才显示:全部完成是正常收尾,不是异常,那时候
                  再报一句警告只会让人以为出了事。
              */}
              {execution === 'stopped' && todos.length - done > 0 && (
                <span className="mt-0.5 block truncate text-[11px] text-warning">
                  {t('chat.taskChecklist.stoppedIncomplete', { count: todos.length - done })}
                </span>
              )}
              {/*
                需求:快照档要**明说自己不是实时进度**,否则历史清单和输入框上方那条
                长得一模一样,用户分不清哪一份还有人在推。
              */}
              {execution === 'snapshot' && (
                <span className="mt-0.5 block truncate text-[11px] text-fg-faint">
                  {t('chat.taskChecklist.snapshot')}
                </span>
              )}
            </span>

            <span aria-hidden className="shrink-0 text-[10.5px] tabular-nums text-fg-faint">{Math.round(progress * 100)}%</span>
            <ChevronDown
              aria-hidden
              size={14}
              className={cn(
                'shrink-0 text-fg-faint transition-transform duration-200 motion-reduce:transition-none',
                collapsed && '-rotate-90'
              )}
            />
          </button>
        )}
      />
    </div>
  )
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 9

/**
 * 进度环 + 完成数。标题行和缩起后的小球画的是**同一颗**:小球是这一行缩出来的,
 * 两处长得不一样,用户就认不出它们是同一个东西。
 */
function ProgressRing({ progress, done }: { progress: number; done: number }): ReactNode {
  return (
    <span aria-hidden className="relative flex size-6 shrink-0 items-center justify-center">
      <svg className="absolute inset-0 -rotate-90" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-stroke)" strokeWidth="2" />
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
          className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      </svg>
      <span className="relative text-[9px] font-semibold tabular-nums text-fg">{done}</span>
    </span>
  )
}
