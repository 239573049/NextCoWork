/**
 * 会话目标（goal）—— 「模型不再答完就停，而是持续工作到一个独立判定器确认条件达成」。
 *
 * ## 这里只有形状和纯规则
 *
 * 判定怎么调、什么时候续跑、定时器挂在哪，全在 `main/goal/`。放在 shared 的
 * 只有三样：`ActiveGoal`（IPC 要跨到渲染层）、`GoalVerdict`（判定结论）、
 * 以及条件本身的规范化与清除词 —— 它们是**同一份规则**，斜杠命令、`ProposeGoal`
 * 工具、IPC 三个入口都要用，各写一份就会各漂各的。
 */
import { z } from 'zod'
import type { AgentMessage, ContentPart } from '../agent/message'
import type { SendOptions } from '../agent/run-request'

export interface GoalChange {
  sessionId: string
  goal?: ActiveGoal
  /** UI-only marker update; applying it must preserve live stream blocks. */
  message?: AgentMessage
  /** Delivered to one renderer, through its existing internal-message send path. */
  input?: { goalId: string; parts: ContentPart[]; options: SendOptions }
}

/** 目标是谁设的。遥测与 UI 文案都按它分叉。 */
export type GoalOrigin = 'user' | 'proposal_direct' | 'proposal_approved' | 'restored'

/** 目标被清掉的原因。只进遥测与日志，不进 UI 文案。 */
export type GoalClearReason =
  | 'user_clear'
  | 'superseded'
  | 'met'
  | 'impossible'
  | 'session_ended'
  | 'run_failed'

export interface ActiveGoal {
  /** A new identity for every set, including replacement with the same condition. */
  id: string
  /**
   * 完成条件。
   *
   * ★ 必须是「判定器**只看对话**也能核」的那一种 —— 判定器跑不了命令、读不了文件，
   *   所以「测试全绿」要写成「`bun test` 退出码为 0（转录里有这次运行的输出）」。
   *   这条硬约束写在判定器 system prompt 和 `ProposeGoal` 的工具描述里。
   */
  condition: string
  origin: GoalOrigin
  /** 已评估轮数（达成 / 未达成各算一次；超时与出错**不算**）。 */
  iterations: number
  setAt: number
  tokensAtStart: number
  /** 上一次判未达成的理由。UI 那行「上次判定」用它。 */
  lastReason?: string
  /** 后台子代理在跑而推迟判定的起点。缺席 = 当前不处于推迟态。 */
  deferredSince?: number
  /** 本轮推迟已注入过几次 check-in。 */
  checkinCount: number
  lastDeferralPassAt?: number
  /** 空闲定时器注入次数，到 `GOAL_IDLE_CHECKIN_CAP` 封顶。 */
  idleCheckinCount?: number
  /** Tokens consumed since this goal was activated, updated from the usage ledger. */
  tokens?: number
}

/** 判定器的一次结论。 */
export type GoalVerdict =
  | { kind: 'met'; reason: string }
  | { kind: 'not_met'; reason: string }
  | { kind: 'impossible'; reason: string }
  | { kind: 'skipped'; reason: 'timeout' | 'error' | 'no_model' | 'deferred' | 'transcript_empty' }

/**
 * 判定器回包的契约。
 *
 * ★ 走「JSON 写进 system prompt + 容错解析」，**不**给 `CanonicalRequest` 加
 *   `responseFormat`：结构化输出在 OpenAI 兼容 / Bedrock / Vertex 各家的支持程度
 *   不一样，而供应商是用户自己挑的。容错解析跨家一致。
 */
export const goalVerdictSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  impossible: z.boolean().optional()
})

export type GoalVerdictPayload = z.infer<typeof goalVerdictSchema>

/** 条件上限。超了**拒绝**，不截断 —— 截断后的条件是一个用户没同意的目标。 */
export const GOAL_CONDITION_MAX = 4000
/** `ProposeGoal` 那条更严：模型提的目标必须是一句能核的话，不是一篇需求。 */
export const GOAL_PROPOSAL_CONDITION_MAX = 500

/**
 * `/goal` 的清除词。照搬 Claude Code 那一组。
 *
 * ★ 一个恰好叫 `stop` 的「条件」当清除指令处理，是刻意的：用户打 `/goal stop`
 *   的意图在任何真实场景里都是「别再跑了」，而不是「请你把条件设成 stop 这个词」。
 */
export const GOAL_CLEAR_WORDS: readonly string[] = ['clear', 'stop', 'off', 'reset', 'none', 'cancel']

/**
 * 条件规范化。
 *
 * ★ 剥掉不可见字符**之后**再判空：一串零宽空格看起来是「用户写了东西」，
 *   而判定器收到的是一个空条件 —— 它会稳定地判未达成，于是这一轮永远停不下来。
 */
export function normalizeGoalCondition(text: string): string {
  return text
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    // eslint-disable-next-line no-control-regex -- Preserve whitespace separators, strip invisible controls.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .trim()
}

export function isGoalClearWord(text: string): boolean {
  return GOAL_CLEAR_WORDS.includes(normalizeGoalCondition(text).toLowerCase())
}

/** `/goal <参数>` 的语义。三种结局各自对应一条不同的路径，不要在调用方再判一次。 */
export type GoalCommandIntent =
  | { kind: 'show' }
  | { kind: 'clear' }
  | { kind: 'set'; condition: string }
  | { kind: 'invalid'; reason: 'empty' | 'too_long'; length: number }

export function parseGoalCommand(args: string, max = GOAL_CONDITION_MAX): GoalCommandIntent {
  const text = normalizeGoalCondition(args)
  if (text === '') return args.trim() === ''
    ? { kind: 'show' }
    : { kind: 'invalid', reason: 'empty', length: 0 }
  if (isGoalClearWord(text)) return { kind: 'clear' }
  if (text.length > max) return { kind: 'invalid', reason: 'too_long', length: text.length }
  return { kind: 'set', condition: text }
}

/**
 * 判定器那段文本 → `GoalVerdict`。
 *
 * ★ 解析失败**不是** `not_met`。把工具的故障算在用户的目标头上，会让一次
 *   供应商抖动变成一条「你的目标没达成」—— 用户据此去改一个本来没问题的条件。
 */
export function parseGoalVerdict(text: string): GoalVerdict {
  const payload = extractJson(text)
  if (payload === null) return { kind: 'skipped', reason: 'error' }
  const parsed = goalVerdictSchema.safeParse(payload)
  if (!parsed.success) return { kind: 'skipped', reason: 'error' }
  const reason = parsed.data.reason?.trim() ?? ''
  if (parsed.data.ok) return { kind: 'met', reason }
  if (parsed.data.impossible === true) return { kind: 'impossible', reason }
  return { kind: 'not_met', reason }
}

/**
 * 从一段可能夹着围栏和解释文字的模型输出里抠出那个 JSON 对象。
 *
 * 取向照抄 `reviewSensitiveOperation` 的容错解析：先试整段，再试 ```json 围栏，
 * 最后试「第一个 `{` 到最后一个 `}`」。三条都不成才算读不懂。
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1]
  if (fenced !== undefined) candidates.push(fenced.trim())
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // 试下一种写法
    }
  }
  return null
}
