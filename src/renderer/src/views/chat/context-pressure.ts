/**
 * 状态行那根压力条**此刻**该画多满、旁边那句「接近上限」还成不成立。
 *
 * 需求:上下文圆环的分母是本地实时算的有效窗口(`effectiveContextWindow`),
 * 用户在圆环菜单里打开「最大上下文」,它当帧就从 272K 变成 1M;而状态行读的是
 * `transcript.contextUsage` —— 上一次请求装配时主进程算好发回来的
 * `used / window / shouldCompact`,窗口还是旧的。于是一屏之内两个读数打架:
 * 圆环写着 21%,同一行左边却挂着「超载中…请开启摘要压缩或另起会话」,
 * 而那正是用户刚刚做完的事(他把窗口放开了)。这个模块负责把分母换成当前窗口,
 * 并回答那条建议还该不该说。
 *
 * ★ **分子不动。** `used` 是上一次请求的既成事实,没有任何办法让它实时 ——
 * 能实时的只有分母。这条边界是有意的,不要为了「都实时」去估一个本地的 used:
 * 那会变成界面上第三个互相对不上的占用读数。
 *
 * ★ **本地重判永远不会比主进程更严格,这是可以证明的。** 主进程判据读的是
 * 校准后的估算(`calibratedInputTokens`,校准系数下界为 1,见 assembler 的
 * `MIN_TOKEN_CALIBRATION`),这里读的是未校准的 `used` ≤ 它;`shouldCompactAt`
 * 对输入单调,所以本地算出 true 时主进程必然也是 true。也就是说:窗口没变时
 * 这里逐字等价于主进程那一次判断,不会凭空多出一句警告。
 */
import { shouldCompactAt } from '../../../../shared/agent/context-management'

/** 上一次请求结束时主进程报的占用 —— 既成事实。 */
export interface LastContextUsage {
  used: number
  window: number
  shouldCompact: boolean
}

/**
 * 此刻药丸说了算的那一档。两个字段**必须同时有**:只有窗口没有最大输出的话,
 * 判据里的输出预留就得自己编一个,而那正是 `OUTPUT_RESERVE_CAP` 的注释里
 * 记着的那个「恒为真的判据」的来路。模型别名查不到时整个不传,退回主进程的结论。
 */
export interface CurrentContextLimits {
  /** `effectiveContextWindow(alias.contextWindow, maxContext)` —— 和圆环同一个数。 */
  window: number
  maxOutputTokens: number
}

export interface ContextPressure {
  /** 压力条填充比例,已夹在 0..1。 */
  ratio: number
  /** 「接近上限,可 /compact」该不该出现。 */
  nearLimit: boolean
  /** 用户把窗口改过了,上面两个数是按**新**窗口重算的。 */
  rescaled: boolean
}

export function contextPressure(
  usage: LastContextUsage | undefined,
  current?: CurrentContextLimits
): ContextPressure | undefined {
  // 一次请求都没发过 —— 没有 `used` 可画,不是「0%」。
  if (usage === undefined) return undefined
  const window = current !== undefined && current.window > 0 ? current.window : usage.window
  const ratio = window <= 0 ? 0 : Math.min(1, Math.max(0, usage.used / window))
  if (current === undefined || current.window <= 0) {
    return { ratio, nearLimit: usage.shouldCompact, rescaled: false }
  }
  /*
    需求:窗口**变大**时旧结论必须能被撤销 —— 那正是用户开「最大上下文」的目的;
    窗口没变大时旧结论继续有效 —— 主进程那一次判断读的是校准后的数,比这里准,
    不能因为本地算宽松了就把一句有用的警告抹掉。
    不满足会怎样:前者表现为开了 1M 之后警告还挂着(用户以为设置没生效),
    后者表现为一段真的快撑爆的会话突然不再提示压缩,直到上游 400。
  */
  const nearLimit =
    shouldCompactAt({
      inputTokens: usage.used,
      contextWindow: current.window,
      maxOutputTokens: current.maxOutputTokens
    }) || (usage.shouldCompact && current.window <= usage.window)
  return { ratio, nearLimit, rescaled: current.window !== usage.window }
}
