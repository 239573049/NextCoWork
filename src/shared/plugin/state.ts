/**
 * 一个已安装插件在**界面上**的样子 —— 主进程与渲染层共用的只读投影。
 *
 * ★ 这里**没有任何句柄**:没有 iframe 引用、没有 MessagePort、没有 Disposable。
 * 渲染层拿到的永远是一份可结构化克隆的数据。把运行期对象混进来会让
 * 「插件详情页」这种纯展示的东西变成必须跑在主进程里的东西。
 */
import type { PluginManifest } from './manifest'
import type { PluginPermission, PluginPermissionState } from './permission'

export type PluginStatus =
  /** 装上了、启用着,但还没被任何激活事件叫醒 */
  | 'idle'
  /** 正在跑 activate() */
  | 'activating'
  | 'active'
  /** 空闲 5 分钟后休眠。下一次激活事件会把它叫回来 */
  | 'asleep'
  /** 用户手动禁用 */
  | 'disabled'
  /**
   * 升级后必选能力变大,**用户不批就不激活**。
   *
   * ★ 这个状态是「装完之后自动更新悄悄扩权」那条路上的闸门,不是一个提示。
   */
  | 'pending-approval'
  /** 装载失败(清单读不懂、engines 不匹配、入口文件缺失) */
  | 'error'

export interface PluginDiagnostic {
  /** 出问题的地方,给插件作者看的:字段路径或包内文件路径 */
  path: string
  message: string
  level: 'info' | 'warn' | 'error'
}

/** 活动日志的一条。环形缓冲,照抄 `main/hooks.ts` 的 `recentFailures`。 */
export interface PluginActivity {
  ts: number
  pluginId: string
  method: string
  /** 人话摘要,**不含参数原文** —— 参数里可能有文件内容 */
  summary: string
  verdict: 'ok' | 'denied' | 'error' | 'timeout'
  durationMs: number
}

/**
 * 插件挂在状态栏上的一格。
 *
 * ★ `textKey` 是 **l10n key**,不是文案。状态栏是全应用**最显眼**的一块
 * 常驻文字 —— 让插件往这里塞任意字符串,等于让它在用户每一秒都看得见的地方
 * 写字,而且切语言之后那行字不会变。
 */
export interface PluginStatusBarItem {
  id: string
  pluginId: string
  textKey: string
  tooltipKey?: string
  /** 点一下执行哪条命令。必须是这个插件自己贡献过的 */
  command?: string
}

export interface InstalledPlugin {
  id: string
  manifest: PluginManifest
  status: PluginStatus
  /** 装在哪 —— 全局(userData)还是这个工作区 */
  scope: 'global' | 'workspace'
  /** 包目录的绝对路径。渲染层只用来「在访达里显示」 */
  path: string
  enabled: boolean
  permissions: PluginPermissionState
  diagnostics: PluginDiagnostic[]
  /** 这一版不实现的贡献点,逐条列给作者看 */
  unsupported: string[]
  installedAt: number
  updatedAt: number
  /** 升级时新增的必选能力 —— 授权界面逐条列,不是只说「权限有变化」 */
  pendingPermissions?: PluginPermission[]
  /** 这一刻它挂在状态栏上的那几格。禁用时必须清空 */
  statusBar: PluginStatusBarItem[]
}

/** 插件系统整体状态,一次 IPC 全量取回。 */
export interface PluginCatalog {
  plugins: InstalledPlugin[]
  /** 宿主这一版的版本号,用于 `engines` 过滤与市场列表 */
  hostVersion: string
}

export function isRunnable(plugin: InstalledPlugin): boolean {
  return plugin.enabled && plugin.status !== 'error' && plugin.status !== 'pending-approval'
}
