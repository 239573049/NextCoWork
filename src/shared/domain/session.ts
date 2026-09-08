/**
 * 会话 = 一条转录 + 它的元数据。Tab 只引用它(见 tab.ts)。
 */
import type { AgentMessage } from '../agent/message'
import type { SessionMode, ThinkingLevel } from '../agent/run-request'
import type { ContextCheckpoint } from '../agent/context-management'

export interface Session {
  id: string
  workspaceId: string
  /**
   * ★ 非 undefined = 这条转录属于一次**子代理 run**,不是用户的一条对话。
   *
   * 它是所有「面向用户的枚举」的唯一判据:侧边栏、搜索、数据导出、存储统计、
   * 按时长清理,一处都不出现;而 `getSession` / `getHistory` 照读不误 ——
   * 子代理面板和续跑要用。
   *
   * 判据是这一列而**不是** id 里的 `:sub:`:子会话 id 是递归拼出来的,
   * 从里面反推父亲一定会切错(理由写在 `db/schema.ts` 第 10 条迁移上)。
   */
  parentSessionId?: string
  title: string
  /** Stored in session JSON; absent on older exports. Manual names are never auto-replaced. */
  titleSource?: 'default' | 'generated' | 'manual'
  model: string
  /**
   * 发起这个会话时选定的供应商。★ **这是历史事实,不是待执行的配置** ——
   * 那家后来被删了也不改写它,否则「当时用的哪家」就失真了。
   */
  modelProviderId?: string
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

/** Legacy placeholder values are data; their display labels belong to renderer i18n. */
export function isDefaultSessionTitle(title: string): boolean {
  return ['', '新对话', 'New conversation', 'New chat'].includes(title.trim())
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
  contextCheckpoints?: ContextCheckpoint[]
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
