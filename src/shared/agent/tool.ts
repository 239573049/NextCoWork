/**
 * 一个对象,两个名字 —— 方案 §4.3。
 *
 * 类型放在 shared 是因为渲染层要渲染它们(审批弹窗要显示工具名与入参、
 * 设置页要列 MCP 工具)。**运行时的 Tool 对象只有主进程有**,因为 execute 是闭包。
 */
import type { ToolOutput } from './message'

/**
 * 最小可用的 JSON Schema 形状。刻意不引 `@types/json-schema` ——
 * 我们只用 zod 生成、原样下发给上游,自己不解释它。
 */
export type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  [k: string]: unknown
}

export type ToolSource =
  | { kind: 'builtin' }
  | { kind: 'mcp'; serverId: string }
  | { kind: 'skill'; skillId: string }

/**
 * ★ 两个名字是必须的:Anthropic 把工具名限制在 ^[a-zA-Z0-9_-]{1,64}$。
 * `mcp__github-enterprise-internal__create_pull_request_review_comment` 直接超 64,
 * 换来一个什么都没说清楚的 400。
 *
 * 注册表负责生成经消毒、截断、带短哈希去重的 externalName,
 * 且该映射**在一次会话内必须稳定** —— 已落盘的转录里存的是旧名字。
 */
export interface ToolInfo {
  /** 规范名,不限长:mcp__github-enterprise__create_pr_review_comment */
  internalId: string
  /** 模型看到的名字:必须匹配 EXTERNAL_NAME_RE */
  externalName: string
  description: string
  inputSchema: JsonSchema
  /** 决定 plan 模式可用性 + 将来的并行调度资格 */
  readOnly: boolean
  /** 决定权限档位(§4.5 那张 5 行表的入参之一) */
  destructive: boolean
  source: ToolSource
}

/** 上游对工具名的硬约束。注册表与网关两侧都按这一个常量校验。 */
export const EXTERNAL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
export const EXTERNAL_NAME_MAX = 64

/**
 * ⚠️ MCP / Skill 提供的工具名与描述是**不可信输入** —— 它们会进入系统提示词,
 * 这正是工具投毒攻击的入口(方案 §4.4)。注册时必须做字符白名单与长度限制。
 */
export const DESCRIPTION_MAX = 4096

/** 进度事件是**易失的** —— 单独的事件类型,永不写入转录(方案 §4.3)。 */
export interface ToolProgress {
  callId: string
  /** 一行人类可读的进度,例如 "读取 src/main/index.ts (12KB)" */
  message: string
  /** 0–1,不确定时省略 */
  fraction?: number
}

export interface ToolResult {
  output: ToolOutput
  isError: boolean
}

export function toolOk(content: string, extra?: Omit<ToolOutput, 'content'>): ToolResult {
  return { output: { content, ...extra }, isError: false }
}

export function toolFail(content: string): ToolResult {
  return { output: { content }, isError: true }
}
