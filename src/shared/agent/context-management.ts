import type { AgentMessage } from './message'

/*
  ★ 三层窗口 —— 一个 `contextWindow` 曾经同时回答三个不同的问题,这里把它们拆开。
  改动任何一层之前,先确认你要动的是哪一个:

  1. **协议窗口** = `ModelAlias.contextWindow` 原值。回答「发出去会不会被上游 400」。
     只有 `validateModelRuntime` 的 context_length 硬校验读它,**永远不受用户开关影响** ——
     模型明明吃得下,我们自己先报错是纯粹的自伤。
  2. **有效窗口** = `effectiveContextWindow()`。回答「我自愿用到多少」。
     它是 `shouldCompact` 的分母,也是圆环的分母。默认被 `LONG_CONTEXT_THRESHOLD` 夹住。
  3. **压缩阈值** = 有效窗口 × `COMPACT_THRESHOLD`(0.8)+ 输出预留,见 `shouldCompactAt()`。
     回答「什么时候开始压」。原先只长在 kernel/context-assembler.ts 里(所以这里写着
     「本文件不管这一层」),现在渲染层的状态行也要按当前窗口重判同一条不等式,
     故下沉到本文件,装配器改为调用它 —— 判据仍然只有一份。
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

/** 超过窗口的这个比例就该压缩了 */
export const COMPACT_THRESHOLD = 0.8

/**
 * 输出预留最多吃掉窗口的这个比例。
 *
 * ★ **`maxOutputTokens` 和有效窗口不同源,不封顶就会算出一个恒为真的判据。**
 * 前者是别名上的原值(按模型的**协议**窗口标的),后者默认被 `LONG_CONTEXT_THRESHOLD`
 * 夹到 272K。一个 1M 窗口、384K 最大输出的模型,关掉「最大上下文」之后
 * 预留一项就是 384K —— 已经超过 272K×0.8 的阈值本身,于是 `used` 填 0 都判该压缩:
 * 自动压缩从会话第一条消息起每轮触发一次,而且压完仍然为真,永远收敛不了。
 * 症状是压力条几乎空着、旁边却写着「接近上限」。
 *
 * 封顶到 1/4 之后,最坏情况下压缩也要等占用过半才触发,判据重新跟历史长度有关。
 * 这不是在猜模型真实会输出多少 —— 一轮回复本来就不可能写满协议上限,
 * 而真正兜住「输入塞得下、输出被截断」的是 `validateModelRuntime` 那条硬校验,
 * 它读协议窗口原值,不受这里影响。
 */
export const OUTPUT_RESERVE_CAP = 0.25

/**
 * 「这一轮该压缩了吗」。
 *
 * ★ 把输出预留算进来:上下文窗口是**输入加输出**共用的。只比较输入的话,
 * 你会在「输入刚好塞得下、回复写到一半被截断」时才发现该压缩了 —— 而那时
 * 这一轮已经浪费了。预留取 `maxOutputTokens` 但**必须封顶**,见 `OUTPUT_RESERVE_CAP`。
 *
 * 需求:这三样原先长在 `kernel/context-assembler.ts` 里(主进程装配时判一次,
 * 结果随 `context_usage` 发到渲染层)。下沉到这里是因为状态行那句「接近上限,可 /compact」
 * 现在要按**当前**有效窗口重判一次 —— 用户中途打开「最大上下文」之后,
 * 上一轮在 272K 下判出来的那条建议已经不成立了,而它要到下一次发送才会自己回落。
 * 两边必须读同一个公式:各写一份的话,状态行会和真正触发自动压缩的那条判据悄悄分叉。
 *
 * ★ 渲染层传进来的 `inputTokens` 是上一轮装配的**未校准估算**(`contextUsage.used`),
 * 主进程传的是**校准后的估算**(见 assembler 的 `tokenCalibration`)。校准系数下界为 1,
 * 所以渲染层重判不会比主进程更严格;这个函数只负责两边共用的那条不等式。
 */
export function shouldCompactAt(input: {
  inputTokens: number
  contextWindow: number
  maxOutputTokens: number
}): boolean {
  return (
    input.inputTokens + Math.min(input.maxOutputTokens, input.contextWindow * OUTPUT_RESERVE_CAP) >
    input.contextWindow * COMPACT_THRESHOLD
  )
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

// ─────────────────────────── 占用归因 ───────────────────────────

/**
 * 上下文**被谁占掉了**。
 *
 * ★ 这是归因,不是余量 —— 分母是「已用」而不是窗口,所有档相加恒等于 `used`。
 * 上面那三层窗口回答「还装得下多少」,这一组回答「已经装进去的那些是什么」,
 * 是两个不同的问题:一个 3.4% 的读数配上「MCP 占了其中 42%」才是可行动的,
 * 单看余量只能得出「还早着呢」,而挂满 MCP 的工作区在**一句话都没聊**的时候
 * 就已经少掉半个窗口了。
 *
 * ★ 分档就是分档到**用户能关掉的那个东西**。`tools-mcp` 因此带 `detail`
 * (按 server 拆):「MCP 占 42%」不可行动,「github 这一个占 28%」可以。
 * 同理没有 `tools-skill` 这一档 —— 技能的清单段和它带的工具对用户是**一件事**
 * (设置里就是一个开关),拆成两行只会让人以为关掉技能只省下其中一半。
 */
export type ContextSegmentKind =
  /** 基础提示词 + 角色 + 环境事实 + 模式附录。用户关不掉,但它是基线。 */
  | 'system'
  /** 技能清单段 + 技能注册的工具。 */
  | 'skills'
  | 'tools-builtin'
  | 'tools-mcp'
  /** 个性化、AGENTS.md、每轮注入的状态块 —— 用户自己写进去的那些。 */
  | 'instructions'
  /** 真实对话(含工具结果)。压缩唯一能减掉的就是这一档。 */
  | 'messages'

export interface ContextSegmentDetail {
  id: string
  label: string
  tokens: number
}

export interface ContextSegment {
  kind: ContextSegmentKind
  tokens: number
  /** 目前只有 `tools-mcp` 填,按 token 降序。 */
  detail?: ContextSegmentDetail[]
}

/**
 * 归因用的百分比:分母是**已用量**,不是窗口。
 *
 * ★ 空会话(`used` 为 0)返回 0 而不是 NaN —— 界面上 `NaN%` 是个渲染 bug 的样子,
 * 而这里的 0 是真的:还没发过请求,确实什么都没占。
 */
export function contextSegmentShare(tokens: number, used: number): number {
  if (!Number.isFinite(used) || used <= 0) return 0
  return Math.max(0, Math.min(1, tokens / used))
}

/**
 * **还没发过请求时**的归因 —— 装配一次但不发出去。
 *
 * ★ 它存在的理由就是这个功能最值钱的那一半:一个挂满 MCP 的工作区在**一句话
 * 都没聊**的时候就已经少掉半个窗口,而那个数只有在你还没开始聊的时候看见才有用。
 * 等第一条消息发出去,窗口已经被占了,再看只是事后报告。
 *
 * ★ 它是**估算**,和 `transcript.lastInputTokens`(上游回报的真值)不是一个东西。
 * 所以界面上只有在真值还不存在时才拿它顶上,一旦有过一轮真实请求就让位。
 */
export interface ContextPreview {
  used: number
  window: number
  segments: ContextSegment[]
}

export type ContextCheckpointSource = 'model' | 'mechanical' | 'manual' | 'auto'
/**
 * 自动压缩这一轮的结局。
 *
 * ★ `fallback` 与 `exhausted` **必须分开**:前者是默认配置下每次自动压缩的正常结果
 * (折叠了较早的历史,占用真的降下来了),后者是「折叠完还是这么大」——
 * 机械压缩只动倒数第 6 条之前的工具输出 / 思考 / 图,大头在保留区或纯正文里时
 * 它一个 token 都削不掉。两者报成同一句话的话,用户会盯着一句「已折叠较早的历史」
 * 看着占用一路涨过窗口,而**此时唯一有用的动作全在他那边**(开摘要压缩、
 * 换更大的窗口、另起一个会话)。
 */
export type ContextStatusPhase = 'preparing' | 'ready' | 'fallback' | 'exhausted' | 'error'

export interface ContextSearchHit {
  messageId: string
  role: AgentMessage['role']
  createdAt: number
  snippet: string
}

/**
 * 这一刀**实际**做了什么 —— 检查点上那条 note 之外的全部事实。
 *
 * ## 需求:压缩过后必须能回答「我丢了什么」
 *
 * 在此之前检查点只有 `note` 和一对 token 读数,于是用户(和下一个 agent)看到的
 * 是「压缩了」三个字,看不到**哪些消息不再发给模型**、**摘要有没有真的读过它们**。
 * 而这两件事恰恰是「压缩之后模型像换了个人」的全部解释。
 *
 * ★ 合成一个可选对象而不是往 `ContextCheckpoint` 上铺七个平行可选字段:
 * 落库只多一列 JSON(同 `searchHits` 的先例),老行读出来是 `undefined` ——
 * 界面对「没有这份事实」和「事实是 0」必须有不同反应,平铺成 0 会把老会话
 * 谎报成「一条都没丢」。
 */
export interface ContextCompactionDetail {
  /** 被削掉内容(工具输出清空 / 丢思考 / 图换占位)的消息条数。 */
  foldedMessages?: number
  /** 其中被清空的工具输出处数 —— 体积的大头。 */
  foldedToolOutputs?: number
  /** 真正**移出上下文**的消息条数。0 / 缺席 = 只折叠了内容,一条都没移走。 */
  droppedMessages?: number
  /** 最后一条被移出上下文的消息;它之前的都不再发给模型。 */
  droppedThroughMessageId?: string
  /**
   * 摘要**没有**覆盖到的那一段从哪条消息开始。
   *
   * ★ 它存在的理由是一个真实的凭空丢失:digest 有 token 预算,超了就从最早的一侧
   * 整条丢(见 `buildCompactionDigest`),而检查点原先一律把 `coveredThroughMessageId`
   * 写成转录的最后一条 —— 于是那些**没进摘要**的消息被当成「已覆盖」裁掉了。
   * 有了这一条,`projectContextWindow` 的切点就不会越过它。
   */
  uncoveredFromMessageId?: string
  /** digest 因预算被整条丢弃的消息条数。 */
  digestOmittedMessages?: number
  /** 真正发给摘要模型的那段 digest 原文。机械压缩没有这一项(它不发请求)。 */
  digest?: string
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
  /** 见 `ContextCompactionDetail`。老检查点没有这一份。 */
  detail?: ContextCompactionDetail
  createdAt: number
  updatedAt: number
  revision: number
}

/**
 * 「压缩之后,这一轮真正发给模型的是什么」—— 上下文检查器的数据形状。
 *
 * ★ 它是**投影的投影**:不搬运整份消息体(一条 tool_result 可以有 64KB),
 * 只带每条的身份、估算占用和一行预览。界面要回答的是「谁还在、谁被削过、
 * 谁彻底没了」,不是「把转录再渲染一遍」——那一份用户本来就在屏幕上看着。
 */
export type ContextWindowEntryKind = 'summary' | 'skeleton' | 'folded' | 'verbatim'

export interface ContextWindowEntry {
  /** 转录里的消息 id。摘要 / 骨架这类合成消息给的是它们自己的 id。 */
  id: string
  role: AgentMessage['role']
  kind: ContextWindowEntryKind
  tokens: number
  /** 每个块一行的预览,已限长。 */
  lines: string[]
}

export interface ContextWindowView {
  checkpointId: string
  /** 投影里的消息,顺序即发送顺序。 */
  entries: ContextWindowEntry[]
  /** 转录里存在、但这一份投影里已经没有的消息 id。 */
  droppedMessageIds: string[]
  /** 消息部分的估算占用(不含系统提示词与工具定义)。 */
  messageTokens: number
  /** 压缩前同一段转录的估算占用,用来给出「省了多少」。 */
  transcriptTokens: number
}

/**
 * 历史被改写之后**锚不回去**的检查点 —— 它描述的那段消息已经不在了。
 *
 * 删一轮 / 编辑后重跑都会截掉一段消息,而检查点表**不跟着动**:留下来的孤儿
 * 有两重害处。界面上它落进顶部那个「上下文检查点」面板赖着不走(画不出线,
 * 因为锚点没了);更要命的是 `agent-session` 启动时会把最新那条非机械检查点
 * 当作 `contextNote` 恢复回来,于是一段**描述已删内容**的摘要被继续塞进每一次
 * 请求 —— 用户删了消息,模型却还记得,而且全程不报错。
 *
 * ★ **判据只看锚点消息在不在,不看覆盖范围。** 删掉一轮早期对话时,后面那条
 * 检查点的摘要里确实混着被删内容,但它同时概括了大量**还在**的消息;为那几句
 * 整条丢掉,压缩线和折叠计数会一起凭空消失。锚点还在 = 这条线还有地方可落。
 *
 * ★ **没有锚点字段的老数据一律留着。** 分不清它是「历史还在」还是「被删了」,
 * 而误删不可逆。它们由 `unanchoredCheckpoints` 交给顶部面板兜底。
 */
export function orphanedCheckpoints(
  keptMessageIds: ReadonlySet<string>,
  checkpoints: readonly ContextCheckpoint[]
): ContextCheckpoint[] {
  return checkpoints.filter(
    (checkpoint) =>
      checkpoint.coveredThroughMessageId !== undefined &&
      !keptMessageIds.has(checkpoint.coveredThroughMessageId)
  )
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
