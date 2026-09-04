/**
 * 工具耗时的计算与显示。
 *
 * 放 shared/ 而不是 renderer/lib/:主进程侧的日志、将来的 run 摘要、以及 UI
 * 三处要显示同一个数字。三处各写一份 `(ms/1000).toFixed(1)` 的结果是
 * 同一次调用在不同地方显示成 `1.2s` / `1.24s` / `1s`,看着像三个不同的数。
 *
 * ★ 这里全是纯函数,没有 Date.now() —— 打戳是 reducer 的事(`transcript.ts`),
 * 这里只做减法和格式化,所以能被单测完全锁死。
 */
import type { ToolCallState } from './transcript'

/**
 * 一次工具调用的耗时(毫秒)。
 *
 * 缺任何一头都返回 `undefined` 而不是 0 —— 「还在跑」和「跑了 0 毫秒」在 UI 上
 * 是两件事:前者不该显示耗时,后者该显示 `<0.1s`。用 0 兜底会让运行中的工具
 * 右侧闪出一个 `<0.1s`,看着像已经跑完了。
 *
 * 旧转录(批次 1 之前落盘的)两个字段都没有,一律走这条 undefined 分支,
 * UI 于是不显示耗时 —— 这正是我们要的向后兼容行为。
 */
export function durationOf(c: Pick<ToolCallState, 'startedAt' | 'endedAt'>): number | undefined {
  if (c.startedAt === undefined || c.endedAt === undefined) return undefined
  const ms = c.endedAt - c.startedAt
  // 时钟回拨(NTP 校正、休眠唤醒)会算出负数。显示 `-3.2s` 比不显示更让人困惑,
  // 所以夹到 0 —— 它会显示成 `<0.1s`,语义上正好是「快到测不出」。
  return ms < 0 ? 0 : ms
}

/**
 * 运行中的工具已经跑了多久 —— 供「执行中 12s」这类实时文案使用。
 *
 * `now` 必须由调用方传入(通常是一个每秒 tick 的 state),而不是在函数里
 * `Date.now()`:后者会让这个函数不可测,也会让 React 组件因为每次渲染
 * 拿到不同结果而无法 memo。
 */
export function elapsedOf(
  c: Pick<ToolCallState, 'startedAt' | 'endedAt'>,
  now: number
): number | undefined {
  if (c.startedAt === undefined) return undefined
  if (c.endedAt !== undefined) return durationOf(c)
  const ms = now - c.startedAt
  return ms < 0 ? 0 : ms
}

/**
 * 毫秒 → 人类可读。
 *
 * 分档理由:
 * - `< 100ms` 显示 `<0.1s` 而不是 `0.0s` —— 后者读起来像「没执行」,
 *   而绝大多数 Read/Grep 都落在这一档,满屏 `0.0s` 是噪音。
 * - `< 10s` 保留一位小数:这一档里 1.2s 和 1.9s 的差别用户能感知。
 * - `≥ 10s` 取整:到了两位数秒,小数位不再提供任何决策价值。
 * - `≥ 60s` 用 `1m5s`,不用 `65s` —— 分钟级的等待需要一眼看出量级。
 *
 * ★ **进位必须在取整之后判断。** 直接写 `${m}m${Math.round(rest/1000)}s`
 * 会让 119_500ms 输出 `1m60s`,59_990ms 输出 `60s` —— 都是合法数字组成的
 * 非法读数。下面两处 carry 就是为此。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 100) return '<0.1s'

  if (ms < 60_000) {
    const secs = ms / 1000
    const text = secs.toFixed(ms < 10_000 ? 1 : 0)
    // 59_990 → toFixed(0) === "60" → 该进位成 1m0s,而不是显示 "60s"
    if (Number.parseFloat(text) >= 60) return '1m0s'
    return `${text}s`
  }

  let m = Math.floor(ms / 60_000)
  let s = Math.round((ms % 60_000) / 1000)
  if (s === 60) {
    m += 1
    s = 0
  }
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h${m % 60}m`
  }
  return `${m}m${s}s`
}

/**
 * 直接从一次调用得到显示文案;算不出耗时时返回 `undefined`,
 * 让调用方用 `{text && <span>{text}</span>}` 自然地不渲染。
 */
export function formatCallDuration(
  c: Pick<ToolCallState, 'startedAt' | 'endedAt'>
): string | undefined {
  const ms = durationOf(c)
  return ms === undefined ? undefined : formatDuration(ms)
}

/**
 * 一组调用的**累计**耗时。
 *
 * ★ 叫「累计」不叫「总耗时」是有原因的:工具将来会并行调度
 * (`tool.ts:40` 的 readOnly 字段正是为此),并行时各段耗时之和会明显大于
 * 墙钟时长。文案写「累计 12.4s」永远是对的,写「总耗时 12.4s」在并行下是错的。
 *
 * 算不出耗时的调用按 0 计入,不影响其余项。
 */
export function totalDuration(calls: readonly Pick<ToolCallState, 'startedAt' | 'endedAt'>[]): number {
  let total = 0
  for (const c of calls) total += durationOf(c) ?? 0
  return total
}
