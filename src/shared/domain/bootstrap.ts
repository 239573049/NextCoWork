/**
 * 首屏握手载荷 —— 协议 §7 的时序:
 * `window:ready` → `app:getBootstrap` → 首屏 → 增量事件。
 *
 * 一次拿全,而不是让渲染层开局打七八个 invoke —— 那样会出现「设置到了但工作区还没到」
 * 的中间态,每个组件都得写一遍 loading 分支。
 */
import type { RunStatus } from '../agent/event'
import type { AppSettings, ResolvedTheme } from './settings'
import type { WindowKind, WindowTabState } from './tab'
import type { Workspace } from './workspace'

export interface Bootstrap {
  windowKind: WindowKind
  settings: AppSettings
  /** 主进程 nativeTheme 解析后的实际主题,渲染层直接写 data-theme */
  resolvedTheme: ResolvedTheme
  workspaces: Workspace[]
  /** 上次退出时的外层 Tab 布局(含**用户拖出来的顺序**),从 kv 表读 */
  tabState: WindowTabState
  /**
   * ★ 启动时仍在跑的 run。正常冷启动是空的 —— 「永不恢复运行中状态」(方案 §9)。
   * 非空只发生在渲染层重载(⌘R)时:主进程没重启,run 还活着。
   */
  activeRuns: Array<{ runId: string; sessionId: string; workspaceId: string; status: RunStatus }>
  /** Background child runs survive a renderer reload and are restored into their parent Task card. */
  activeSubagents?: Array<{
    runId: string
    parentRunId: string
    sessionId: string
    workspaceId: string
    status: RunStatus
    startedAt?: number
  }>
  versions: {
    app: string
    electron: string
    chrome: string
    node: string
  }
}
