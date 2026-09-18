/**
 * 浏览器工作台的跨进程数据结构。
 *
 * 浏览器标签不是窗口级资源，而是工作区级资源。`ownerSessionId` 保持同一会话跨 turn
 * 的控制权，`ownerRunId` 记录最近使用它的 run；其他会话仍然不能读取或操作页面。
 */
export type BrowserTabSource = 'user' | 'agent'
export type BrowserTabStatus = 'loading' | 'ready' | 'error'
export type BrowserTabBackend = 'iab' | 'headless'

export interface BrowserViewport {
  width: number
  height: number
}

export interface BrowserTab {
  id: string
  workspaceId: string
  /** Renderer tab identity used to reconcile IPC events with optimistic UI. */
  clientTabId?: string
  ownerRunId?: string
  ownerSessionId?: string
  profileId?: string
  source: BrowserTabSource
  backend: BrowserTabBackend
  url: string
  title: string
  status: BrowserTabStatus
  viewport?: BrowserViewport
  createdAt: number
  updatedAt: number
}

export interface BrowserChange {
  workspaceId: string
  tabs: BrowserTab[]
  /** Agent 打开浏览器时请求右侧工作台展开；仅影响这个工作区。 */
  rightPanelOpen?: boolean
}

/** Browser CUA coordinates are CSS viewport pixels, never physical-screen pixels. */
export interface BrowserCuaEvent {
  workspaceId: string
  tabId: string
  kind: 'move' | 'click' | 'type'
  x: number
  y: number
  at: number
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
