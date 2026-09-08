/**
 * 消息是「内容块数组」,不是字符串 —— 方案 §4.1,整个方案里最不能省的一条。
 *
 * 同类产品无一例外都从 content: string 迁移到了块模型,而迁移成本极高
 * (要动持久化格式)。这里从第一天就是块。
 */
import type { AgentError } from './error'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ContentPart[]
  createdAt: number
  /** 每条记录带版本号 —— 最便宜的保险(方案 §9) */
  schemaVersion: 1
}

/** Durable metadata attached to a Task tool result for UI reconstruction. */
export interface SubagentResult {
  childRunId: string
  status?: 'running' | 'done' | 'error' | 'aborted'
  summary?: string
  /** Terminal error, including localization metadata, retained for UI diagnostics. */
  error?: AgentError
  background?: boolean
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; opaque?: unknown }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: ToolOutput; isError: boolean; subagent?: SubagentResult }
  | { type: 'subagent'; callId: string; childRunId: string; summary?: string }
  | { type: 'image'; mime: string; dataRef: string }
  /**
   * 拖入输入框的非图片文件。★ 不落盘、不经过 attachment 表 ——
   * `path` 是用户机器上的真实绝对路径,只给模型的文件读取工具用,
   * 渲染层把它当成一张只读 chip 显示,**不**当文本塞进气泡里
   * (那会把一整条长路径糊进 `<p>`,撑出横向滚动条)。
   */
  | { type: 'file_ref'; path: string; name: string }
  | { type: 'error'; error: AgentError }

/**
 * `file_ref` → 发给模型的那句话。★ 用标准 markdown 链接语法而不是
 * `[附件] path` 这种自造的方括号提示 —— 模型对 `[text](target)` 训练得多,
 * 括号包住路径也让它在正文里视觉上是一个独立单元,不会跟前后的普通文字粘连。
 */
export function fileRefMarkdown(p: { name: string; path: string }): string {
  return `[${p.name}](${p.path})`
}

/**
 * 工具输出在**工具边界**截断并留明确标记 —— 不要让一个返回 40MB 文件的工具
 * 冲垮 IPC 队列(方案 §4.3)。截断发生在产出侧,不在渲染侧。
 */
export interface ToolOutput {
  content: string
  /** 被截断时为 true,UI 据此显示「输出已截断」 */
  truncated?: boolean
  /** 截断前的原始字节数,给 UI 显示「共 N MB」 */
  originalBytes?: number
}

/**
 * ★ opaque 是厂商透传逃生舱(方案 §4.1)。
 *
 * Anthropic 扩展思考返回的 thinking block 带 signature,下一轮必须原样回传,丢了就报错;
 * 还有 redacted_thinking、缓存断点标记。因为 parts 要落盘,这个字段事后加等于一次数据迁移。
 * 内核不解释它,只负责存下来、原样送回去。
 */

// ─── 便利构造器:全项目只在这里 mint 消息,保证 schemaVersion 不会漏 ───

export function userMessage(id: string, parts: ContentPart[], now: number): AgentMessage {
  return { id, role: 'user', parts, createdAt: now, schemaVersion: 1 }
}

export function assistantMessage(id: string, parts: ContentPart[], now: number): AgentMessage {
  return { id, role: 'assistant', parts, createdAt: now, schemaVersion: 1 }
}

/**
 * 模型看到的历史 = parts 的一个**纯函数投影**;UI 看到的是另一套
 * (含审批提示、进度、子代理折叠节点)。两者是不同的数据,混在一起后患无穷(方案 §4.1)。
 * 这个 helper 是「双轨转录」里 UI 那一轨常用的:取出可显示的纯文本。
 */
export function visibleText(m: AgentMessage): string {
  return m.parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * 中断收尾要用:找出所有已开启但没有配对 tool_result 的 tool_call。
 * 漏掉它们,下一轮的消息数组就是非法的 —— Anthropic 要求每个 tool_use 都必须在
 * 紧随的 user 消息里有配对的 tool_result(方案 §4.8 第 4 步)。
 */
export function orphanedToolCalls(messages: AgentMessage[]): Array<{ callId: string; name: string }> {
  const opened = new Map<string, string>()
  const closed = new Set<string>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_call') opened.set(p.callId, p.name)
      else if (p.type === 'tool_result') closed.add(p.callId)
    }
  }
  return [...opened.entries()]
    .filter(([callId]) => !closed.has(callId))
    .map(([callId, name]) => ({ callId, name }))
}

/**
 * ★ 工具结果放在一条 **user** 消息里,不是接在助手消息后面 —— 方案 §4.1
 * 「内部格式按 Anthropic 形状建模」的字面含义。
 *
 * 这不是风格选择:Anthropic 要求 tool_result 出现在紧随的 user 消息中,
 * 而反方向(存成助手消息的一部分、发请求时再拆出来)意味着编码器要重排消息序列 ——
 * 那是**每加一个上游协议就要重写一遍**的逻辑。存成最终形状,编码器就只是映射。
 */
export function toolResultMessage(id: string, parts: ContentPart[], now: number): AgentMessage {
  return userMessage(id, parts, now)
}

/**
 * 这条 user 消息其实是工具回执,不是用户说的话 —— UI 不能把它画成一个用户气泡
 * (会出现一串空白的「用户发言」)。工具结果的展示走 `TranscriptState.tools`,
 * 那里按 callId 索引,信息还更全(状态、进度、耗时)。
 */
export function isToolResultOnly(m: AgentMessage): boolean {
  return m.role === 'user' && m.parts.length > 0 && m.parts.every((p) => p.type === 'tool_result')
}

/**
 * 工具输出在**产出侧**截断(方案 §4.3)—— 不是渲染侧。
 * 一个 `cat` 掉 40MB 文件的工具,不截断的话这 40MB 要过一次结构化克隆、
 * 一次 IPC、一次 SQLite 写入,还要占着上下文窗口。
 */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024

export function truncateToolOutput(content: string): ToolOutput {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) return { content }
  return {
    // 留明确标记,不是静默截断 —— 模型看到这行才知道自己拿到的是残缺输出,
    // 才可能改用更窄的查询重试。
    content:
      content.slice(0, MAX_TOOL_OUTPUT_CHARS) +
      `\n\n[输出已截断:共 ${content.length} 字符,只保留前 ${MAX_TOOL_OUTPUT_CHARS} 个]`,
    truncated: true,
    originalBytes: content.length
  }
}
