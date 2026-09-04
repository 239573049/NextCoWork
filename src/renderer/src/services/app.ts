/**
 * 应用级服务:握手、设置、工作区、Tab 布局持久化。
 *
 * 协议 §7 的握手时序在这里成型:
 *   send('window:ready') → invoke('app:getBootstrap') → 首屏 → on('...') 增量
 */
import type { Bootstrap } from '../../../shared/domain/bootstrap'
import type { DirListing } from '../../../shared/domain/file-tree'
import type { AppSettings, AppSettingsPatch } from '../../../shared/domain/settings'
import type { InnerTabState, WindowKind, WindowTabState } from '../../../shared/domain/tab'
import type { Workspace, WorkspaceSettings } from '../../../shared/domain/workspace'
import { invoke, send } from './ipc'

// ─── 握手 ───

export function announceReady(kind: WindowKind = 'main'): void {
  send('window:ready', { kind })
}

export function getBootstrap(): Promise<Bootstrap> {
  return invoke('app:getBootstrap', undefined)
}

export function openExternal(url: string): Promise<void> {
  return invoke('app:openExternal', { url })
}

// ─── 设置 ───

export function getSettings(): Promise<AppSettings> {
  return invoke('settings:get', undefined)
}

/**
 * ★ 嵌套块**只给要改的那一个属性**,别自己 `{ ...settings.gateway, x }` 组装 ——
 * `settings` 是 prop,在广播回来之前它是旧的,组装等于把兄弟属性回滚。
 * 主进程侧是深合并(shared/domain/settings.ts 的 mergeSettings)。
 */
export function updateSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  return invoke('settings:update', patch)
}

// ─── 工作区 ───

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke('workspace:list', undefined)
}

/** 主进程弹目录选择框;渲染层永不指定路径(方案 §9)。取消时返回 null。 */
export function pickWorkspace(): Promise<Workspace | null> {
  return invoke('workspace:pick', undefined)
}

export function updateWorkspace(req: {
  id: string
  name?: string
  settings?: Partial<WorkspaceSettings>
}): Promise<Workspace> {
  return invoke('workspace:update', req)
}

export function closeWorkspace(id: string): Promise<void> {
  return invoke('workspace:close', { id })
}

/**
 * 列一层目录。`path` 是**工作区相对**路径,`''` = 工作区根。
 * 树是懒加载的,展开一个目录才调一次 —— 别在这里写递归。
 */
export function listDir(workspaceId: string, path: string): Promise<DirListing> {
  return invoke('workspace:listDir', { workspaceId, path })
}

// ─── Tab 布局 ───

export function getInnerTabs(workspaceId: string): Promise<InnerTabState> {
  return invoke('tabs:getInner', { workspaceId })
}

/**
 * ★ 用 send 不用 invoke:拖动排序时每帧都在变,渲染层不需要返回值。
 * 主进程侧防抖 500ms 再落盘。
 */
export function persistOuterTabs(kind: WindowKind, state: WindowTabState): void {
  send('tabs:persistOuter', { kind, state })
}

export function persistInnerTabs(workspaceId: string, state: InnerTabState): void {
  send('tabs:persistInner', { workspaceId, state })
}
