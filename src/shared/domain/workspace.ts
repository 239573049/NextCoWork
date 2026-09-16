/**
 * 工作区(记录)≠ 外层 Tab(视图) —— 方案 §8「三个必须分清的概念」第一条。
 *
 * Workspace 是持久实体;哪些以外层 Tab 打开着、顺序、哪个激活,那是**窗口状态**。
 * 混为一谈的话「关闭工作区 Tab」就会歧义成「忘掉这个项目」。
 */
import type { PermissionMode } from '../agent/permission'
import type { SessionMode, ThinkingLevel } from '../agent/run-request'
import type { EnvironmentRef } from './environment'

export interface Workspace {
  id: string
  name: string
  environment?: EnvironmentRef
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
  /** 与 `defaultModel` 成对:别名撞名时锁定是哪一家。缺席 = 按优先级择优 */
  defaultModelProviderId?: string
  defaultMode: SessionMode
  defaultThinking: ThinkingLevel
  webSearch: boolean
  /**
   * 「最大上下文」:关(默认)时有效窗口夹在 `LONG_CONTEXT_THRESHOLD`(272K)以内,
   * 开则放开到模型的协议窗口。见 `agent/context-management.ts` 文件头的三层窗口。
   *
   * ★ **可选而非必填** —— 旧库里的工作区 JSON 没有这一项(`repo.ts` 的 `getWorkspace`
   * 是裸 `JSON.parse`,不铺默认值),声明成必填会让类型在运行时说谎。读的地方一律 `=== true`。
   */
  maxContext?: boolean
  /** 按工作区单独启用的 Skill(界面:「Skill 工作区选装模式」) */
  activeSkillIds: string[]
  /** 空清单的含义；缺省兼容旧数据并表示全部可用。 */
  skillSelectionMode?: 'all' | 'explicit'
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  // 新工作区继承“询问批准”，用户可在输入框或设置中主动放宽。
  permissionMode: 'ask',
  defaultModel: '',
  defaultMode: 'code',
  defaultThinking: 'auto',
  /*
    ★ 出厂就开。`WebFetch` 受这个开关管(见 `kernel/permission-gate.ts` 那张表的
    第 1 行:关掉时连只读的联网工具也一律拒),默认 false 的话新用户装完的第一感受
    是「让它查个文档它说不让上网」,而没有任何地方提示开关在哪。
    这不是把权限放宽 —— 用户随时能关,而关掉的效果是硬拒,不是「问一下」。
  */
  webSearch: true,
  /*
    ★ 出厂就关,理由和上面那条**恰好相反**。
    webSearch 默认开,是因为关掉的第一感受是「它说不让上网」而界面没有任何提示;
    maxContext 默认关,是因为打开的后果是**账单翻倍**(超过 272K 后输入 ×2、输出 ×1.5),
    而账单也不会在界面上提示。两边都是「哪个方向的静默损失更大」,答案正好反过来。
  */
  maxContext: false,
  activeSkillIds: [],
  skillSelectionMode: 'all'
}

/**
 * ★ 会话创建时把 rootPath **冻结到会话记录上**(方案 §9)。
 * 这样重新指向工作区不会追溯性地改变旧工具调用的含义。
 */
