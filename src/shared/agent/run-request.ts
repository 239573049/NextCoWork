/**
 * 一次运行的全部输入 —— 方案 §4.8。
 *
 * ★ runId 在这里面,是因为它**由渲染层生成并传入**,不由 agent:run 返回(方案 §3 规则 2)。
 * 否则存在竞态:invoke 的 promise resolve 前内核已吐了三个事件,而渲染层还不知道 runId,
 * 这些事件被直接丢弃。渲染层先 mint 一个 ULID,**订阅在前、启动在后**。
 */
import type { ContentPart } from './message'
import type { PermissionMode } from './permission'

/**
 * 界面 `/` 菜单:/plan 规划模式「先出方案,你确认后再执行」、
 * /goal 目标模式「持续推进,直到目标完成」。
 *
 * ★ 会话模式必须落在**工具层**,不能只靠提示词祈祷(方案 §4.8):
 * - plan → snapshot({ readOnlyOnly: true }) 过滤掉所有写工具 + 提示词追加 + 产出待确认方案
 * - goal → 提高 MAX_TURNS,提示词禁止「我做完了吗」式提前退出
 */
export type SessionMode = 'normal' | 'plan' | 'goal'

export const SESSION_MODES: readonly SessionMode[] = ['normal', 'plan', 'goal']

/** 界面 `/` 斜杠菜单里的三项。`normal` 也列出来 —— 用户要有路退回默认。 */
export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  normal: '普通模式',
  plan: '规划模式',
  goal: '目标模式'
}

export const SESSION_MODE_HINT: Record<SessionMode, string> = {
  normal: '边想边做',
  plan: '先出方案,你确认后再执行',
  goal: '持续推进,直到目标完成'
}

/** 界面:自动/极低/低/中/高/超高/最高/关闭 */
export type ThinkingLevel =
  | 'auto'
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'higher'
  | 'max'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'higher',
  'max',
  'off'
]

export const THINKING_LEVEL_LABEL: Record<ThinkingLevel, string> = {
  auto: '自动',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  higher: '超高',
  max: '最高',
  off: '关闭'
}

/**
 * ThinkingLevel 映射成上游的 thinking 预算;界面原文
 * 「不支持该参数的模型将自动忽略此设置」→ 由 ModelAlias.capabilities.thinking 决定是否下发。
 */
export const THINKING_BUDGET: Record<Exclude<ThinkingLevel, 'auto' | 'off'>, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10_000,
  high: 21_333,
  higher: 32_000,
  max: 64_000
}

export interface RunRequest {
  /** ★ 渲染层 mint 的 ULID,订阅在前、启动在后 */
  runId: string
  sessionId: string
  workspaceId: string

  /** 子代理:父 run 的 id 与深度。depth 0 = 主 run */
  parentRunId?: string
  depth: number

  /** 本轮用户输入。空数组 = 继续跑(排队消息之外的续跑场景) */
  input: ContentPart[]

  mode: SessionMode
  thinking: ThinkingLevel
  /** 即使 full 档,这个开关关掉时网络类工具一律拒绝(方案 §4.5) */
  webSearch: boolean
  /** ★ 快照:run 开始时定死,运行期不变 —— 界面说的「下一次新回复生效」 */
  permissionMode: PermissionMode
  /** ModelAlias.alias,不是上游真实模型名 */
  model: string
  /** 本轮激活的 Skill */
  skillIds: string[]

  /**
   * 这个 run 是哪个子代理在跑(`agents/<name>.md` 的 name)。缺省 = 主 run。
   *
   * ★ 放在 `RunRequest` 里而不是当成启动器的一个私有参数,是因为它得
   * **活得和 run 一样久**:重扫目录之后 `AgentDefinition` 对象会被整体换掉,
   * 而一个正在跑的子 run 仍然要能说出「我是谁」。名字是稳定的,对象不是。
   */
  agentType?: string
}

/** 常量就是常量,不做配置项(方案 §10)。 */
export const MAX_TURNS = 25
export const MAX_TURNS_GOAL = 60
/** 没有深度上限的子代理会指数级烧钱(方案 §4.9) */
export const MAX_DEPTH = 2

export function maxTurnsFor(mode: SessionMode): number {
  return mode === 'goal' ? MAX_TURNS_GOAL : MAX_TURNS
}
