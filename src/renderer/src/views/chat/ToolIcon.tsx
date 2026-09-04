/**
 * 工具行的图标 —— 形态类 + 状态的二维投影。
 *
 * ★ **为什么把图标单独拆一个文件**:图标要同时出现在三处 —— 工具行、
 * 折叠组标题(一排小图标)、工作区区块标题(同样一排)。三处各写一份 map,
 * 迟早会出现「列表里是扳手、摘要里是文件」的错位,而那种错位没人会当 bug 报,
 * 只会觉得这个界面「有点乱」。
 *
 * ★ **运行中不用 spinner,用呼吸环**。一次 run 里可能同时有三五个工具在跑,
 * 多个 spinner 各转各的,转速还不同步 —— 视觉噪音远大于信息量。
 * 一圈静静呼吸的 ring 表达的是同一件事,却不抢注意力。
 */
import {
  Brain,
  FilePen,
  FileText,
  Globe,
  ListTree,
  Plug,
  Search,
  Terminal,
  type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { ToolShape } from '../../../../shared/domain/tool-presenter'
import { cn } from '../../lib/cn'

/**
 * 界面上的四态。数据模型里只有三态(`ToolCallState.status`),
 * `pending` 是**派生**的:live 里有 tool_use 块,但 `tools[callId]` 还没建立
 * —— 也就是 `Thread.tsx` 里那个 `call === undefined` 的处境。
 *
 * 刻意不把 pending 加进 reducer 的枚举:没有任何事件会写入它,
 * 加进去就是一个永远为假的分支。
 */
export type ToolViewStatus = 'pending' | 'running' | 'ok' | 'error'

export const SHAPE_ICON: Record<ToolShape, LucideIcon> = {
  reasoning: Brain,
  read: FileText,
  mutate: FilePen,
  search: Search,
  command: Terminal,
  network: Globe,
  orchestration: ListTree,
  external: Plug
}

/** 形态类的中文名 —— 折叠组标题用它组词(「3 次读取」)。 */
export const SHAPE_LABEL: Record<ToolShape, string> = {
  reasoning: '思考',
  read: '读取',
  mutate: '修改',
  search: '检索',
  command: '命令',
  network: '网络',
  orchestration: '调度',
  external: '外部工具'
}

/** 状态 → 前景色。成功态刻意用 faint:成功是默认结果,不该抢眼。 */
export const STATUS_COLOR: Record<ToolViewStatus, string> = {
  pending: 'text-fg-faint',
  running: 'text-accent',
  ok: 'text-fg-faint',
  error: 'text-danger'
}

export function ToolIcon({
  shape,
  status,
  size = 13
}: {
  shape: ToolShape
  status: ToolViewStatus
  size?: number
}): ReactNode {
  const Icon = SHAPE_ICON[shape]
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        status === 'running' && 'text-accent',
        status === 'error' && 'text-danger',
        status === 'ok' && 'text-accent-soft',
        // 等待态压透明度而不是换颜色:它和「成功」都不该抢眼,
        // 但要能一眼分辨 —— 透明度差比色相差更安静
        status === 'pending' && 'text-fg-faint opacity-40'
      )}
      style={{ width: size + 4, height: size + 4 }}
    >
      {status === 'running' && (
        <span
          aria-hidden
          className="absolute inset-0 animate-pulse rounded-full ring-[1.5px] ring-accent/40"
        />
      )}
      <Icon size={size} />
    </span>
  )
}

/** 一排形态小图标 —— 折叠组与工作区区块的标题行用。 */
export function ShapeStrip({
  shapes,
  size = 11
}: {
  shapes: readonly ToolShape[]
  size?: number
}): ReactNode {
  if (shapes.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-fg-faint">
      {shapes.map((s) => {
        const Icon = SHAPE_ICON[s]
        return <Icon key={s} size={size} />
      })}
    </span>
  )
}
