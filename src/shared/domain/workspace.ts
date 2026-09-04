/**
 * 工作区(记录)≠ 外层 Tab(视图) —— 方案 §8「三个必须分清的概念」第一条。
 *
 * Workspace 是持久实体;哪些以外层 Tab 打开着、顺序、哪个激活,那是**窗口状态**。
 * 混为一谈的话「关闭工作区 Tab」就会歧义成「忘掉这个项目」。
 */
import type { PermissionMode } from '../agent/permission'
import type { SessionMode, ThinkingLevel } from '../agent/run-request'

export interface Workspace {
  id: string
  name: string
  /** ★ 按 { id, rootPath } 存;根目录会在运行期被删除或改名(方案 §9) */
  rootPath: string
  /** 根路径失效时标记它,而不是崩溃 */
  unavailable?: boolean
  settings: WorkspaceSettings
  createdAt: number
  lastOpenedAt: number
}

export interface WorkspaceSettings {
  /** 该工作区的默认档位;每次发送时可临时改(输入框左下角那个下拉) */
  permissionMode: PermissionMode
  defaultModel: string
  defaultMode: SessionMode
  defaultThinking: ThinkingLevel
  webSearch: boolean
  /** 按工作区单独启用的 Skill(界面:「Skill 工作区选装模式」) */
  activeSkillIds: string[]
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  permissionMode: 'auto',
  defaultModel: '',
  defaultMode: 'normal',
  defaultThinking: 'auto',
  webSearch: false,
  activeSkillIds: []
}

/**
 * ★ 会话创建时把 rootPath **冻结到会话记录上**(方案 §9)。
 * 这样重新指向工作区不会追溯性地改变旧工具调用的含义。
 */
