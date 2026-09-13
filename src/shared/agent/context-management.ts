import type { AgentMessage } from './message'

/*
  ★ 三层窗口 —— 一个 `contextWindow` 曾经同时回答三个不同的问题,这里把它们拆开。
  改动任何一层之前,先确认你要动的是哪一个:

  1. **协议窗口** = `ModelAlias.contextWindow` 原值。回答「发出去会不会被上游 400」。
     只有 `validateModelRuntime` 的 context_length 硬校验读它,**永远不受用户开关影响** ——
     模型明明吃得下,我们自己先报错是纯粹的自伤。
  2. **有效窗口** = `effectiveContextWindow()`。回答「我自愿用到多少」。
     它是 `shouldCompact` 的分母,也是圆环的分母。默认被 `LONG_CONTEXT_THRESHOLD` 夹住。
  3. **压缩阈值** = 有效窗口 × `COMPACT_THRESHOLD`(0.8,在 kernel/context-assembler.ts)。
     回答「什么时候开始压」。本文件不管这一层。
*/

/**
 * 别名表里查不到这个模型时,协议窗口按它算。
 * 保守取小:猜大了 `shouldCompact` 会迟到,那一轮直接被上游 400。
 *
 * ★ 它和 `LONG_CONTEXT_THRESHOLD` **必须分开**。合并的话,哪天计费分界挪到 400K,
 * 会顺手把「查不到时的兜底」也改成 400K —— 于是一个真实窗口 128K 的老模型被算成
 * 「还剩 70%」然后 400。两个数各有各的改动理由。
 */
export const FALLBACK_CONTEXT_WINDOW = 200_000

/**
 * OpenAI 现代四款(astra / sol / terra / luna)的长上下文计费分界,
 * 见 `domain/pricing-seed.ts` 里的 `two(272_000, 便宜档, 贵档)`。
 *
 * ★ **这是价格常量,不是能力常量。** 越过它模型照样工作,只是输入 / 缓存读 / 缓存写 ×2、
 * 输出 ×1.5。所以默认把有效窗口夹在这里,等于「默认不越过收费线」;
 * 「最大上下文」开关的准确语义是**花钱开关**,不是解锁更大容量。
 */
export const LONG_CONTEXT_THRESHOLD = 272_000

/**
 * 有效窗口:用户自愿使用的上限。`shouldCompact` 和圆环分母都读这个。
 *
 * `maxContext` 关(默认)→ 夹在计费分界内;开 → 放开到模型的协议窗口。
 * 协议窗口缺失 / 非有限 / 非正 一律落到 `FALLBACK_CONTEXT_WINDOW`。
 */
export function effectiveContextWindow(
  protocolWindow: number | undefined,
  maxContext = false
): number {
  const protocol =
    typeof protocolWindow === 'number' && Number.isFinite(protocolWindow) && protocolWindow > 0
      ? protocolWindow
      : FALLBACK_CONTEXT_WINDOW
  return maxContext ? protocol : Math.min(protocol, LONG_CONTEXT_THRESHOLD)
}

/**
 * 这个模型开「最大上下文」有没有意义 —— 协议窗口得真的比计费分界大。
 *
 * ★ **只用来置灰菜单项,绝不用来 normalize 存下来的值。**
 * `effectiveContextWindow` 的 `min()` 已经兜住了不适用的情况,再去抹掉用户存的 true,
 * 会让「sol → claude → sol」这条常见路径静默丢掉用户的选择。
 * (对照 `normalizeModelThinkingLevel`:那个**必须** normalize,因为下发一个模型不认的
 * reasoning effort 会被上游拒;而这里多存一个 true 不会有任何下游后果。)
 */
export function supportsMaxContext(protocolWindow: number | undefined): boolean {
  return effectiveContextWindow(protocolWindow, true) > LONG_CONTEXT_THRESHOLD
}

/**
 * 圆环上那道「272K 在哪儿」的刻度所处的比例。
 * 有效窗口 ≤ 分界时返回 undefined —— 刻度会正好落在终点,画出来是噪音。
 */
export function longContextTickRatio(
  protocolWindow: number | undefined,
  maxContext: boolean
): number | undefined {
  const effective = effectiveContextWindow(protocolWindow, maxContext)
  if (effective <= LONG_CONTEXT_THRESHOLD) return undefined
  return LONG_CONTEXT_THRESHOLD / effective
}

/**
 * 272_000 → '272K',1_050_000 → '1.05M'。
 *
 * ★ 不要换成 settings/pages/model/pricing-table.ts 的 `compactTokens`:那个要求整除,
 * 1_050_000 会被显示成 '1050K';而且 chat 视图不该反向依赖 settings 目录。
 */
export function formatContextWindow(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number(m.toFixed(2))}M`
  }
  if (n >= 1000) {
    const k = n / 1000
    return `${Number(k.toFixed(k < 10 ? 1 : 0))}K`
  }
  return String(n)
}

export type ContextCheckpointSource = 'model' | 'mechanical' | 'manual' | 'auto'
export type ContextStatusPhase = 'preparing' | 'ready' | 'fallback' | 'error'

export interface ContextSearchHit {
  messageId: string
  role: AgentMessage['role']
  createdAt: number
  snippet: string
}

export interface ContextCheckpoint {
  id: string
  sessionId: string
  windowIndex: number
  note: string
  source: ContextCheckpointSource
  coveredFromMessageId?: string
  coveredThroughMessageId?: string
  inputTokensBefore?: number
  inputTokensAfter?: number
  searchHits?: ContextSearchHit[]
  createdAt: number
  updatedAt: number
  revision: number
}

export interface ContextStatus {
  phase: ContextStatusPhase
  windowIndex?: number
}

/** 发送给摘要模型的旧历史边界，避免把内部状态混入 AgentMessage。 */
export interface ContextCompactionInput {
  messages: readonly AgentMessage[]
  previousNote?: string
  force: boolean
}
