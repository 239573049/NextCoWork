/**
 * 会话 = 一条转录 + 它的元数据。Tab 只引用它(见 tab.ts)。
 */
import type { AgentMessage } from '../agent/message'
import type { SessionMode, ThinkingLevel } from '../agent/run-request'

export interface Session {
  id: string
  workspaceId: string
  title: string
  model: string
  mode: SessionMode
  thinking: ThinkingLevel
  /**
   * ★ 会话创建时冻结的工作区根路径(方案 §9)。
   * 重新指向工作区不会追溯性地改变旧工具调用的含义。
   */
  rootPathAtCreation: string
  /**
   * ★ 永不恢复运行中状态 —— 启动时所有会话一律 idle,
   * 退出时 running 的 run 在转录里追加 interrupted 标记(方案 §9)。
   * 这样就不必构建你并不需要的崩溃恢复机制。
   */
  status: 'idle' | 'running'
  archived: boolean
  favorited: boolean
  createdAt: number
  updatedAt: number
}

/** 左侧边栏下半部分按这个分组(今天 / 昨天 / 更早) */
export type SessionGroup = 'today' | 'yesterday' | 'earlier'

export interface SessionListItem {
  id: string
  title: string
  updatedAt: number
  archived: boolean
  favorited: boolean
  /** 有活跃 run 时侧边栏显示圆点角标;来源是 RunRegistry,不是 UI 状态 */
  running: boolean
}

export interface SessionDetail {
  session: Session
  messages: AgentMessage[]
}

/** conversations:searchAll 的命中项。FTS5 给出的 snippet 带高亮标记。 */
export interface SearchHit {
  sessionId: string
  workspaceId: string
  messageId: string
  title: string
  snippet: string
  createdAt: number
}

export function groupOf(updatedAt: number, now: number): SessionGroup {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (updatedAt >= startOfToday) return 'today'
  if (updatedAt >= startOfToday - 86_400_000) return 'yesterday'
  return 'earlier'
}

export const SESSION_GROUP_LABEL: Record<SessionGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早'
}
