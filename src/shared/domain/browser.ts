/**
 * 浏览器工作台的跨进程数据结构。
 *
 * 浏览器标签不是窗口级资源，而是工作区级资源。`ownerRunId` 只在
 * Agent 创建的标签上存在，用来防止一个 run 读取或操作另一个 run 的页面。
 */
export type BrowserTabSource = 'user' | 'agent'
export type BrowserTabStatus = 'loading' | 'ready' | 'error'

export interface BrowserTab {
  id: string
  workspaceId: string
  /** Renderer tab identity used to reconcile IPC events with optimistic UI. */
  clientTabId?: string
  ownerRunId?: string
  profileId?: string
  source: BrowserTabSource
  url: string
  title: string
  status: BrowserTabStatus
  createdAt: number
  updatedAt: number
}

export interface BrowserChange {
  workspaceId: string
  tabs: BrowserTab[]
  /** Agent 打开浏览器时请求右侧工作台展开；仅影响这个工作区。 */
  rightPanelOpen?: boolean
}

export interface BrowserProfile {
  id: string
  name: string
  isDefault: boolean
  domains: string[]
  startUrl?: string
  createdAt: number
  lastUsedAt: number
}

/**
 * Electron session partition for one workspace/Profile pair.
 *
 * Profile definitions are global, while cookies, local storage and login state
 * remain isolated between workspaces. Keeping the spelling in one shared helper
 * prevents renderer webviews and main-process cookie operations from drifting.
 */
export function browserPartition(workspaceId: string, profileId = 'default'): string {
  return `persist:ncw-workspace-${encodeURIComponent(workspaceId)}-profile-${encodeURIComponent(profileId)}`
}
