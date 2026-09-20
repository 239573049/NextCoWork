/**
 * 「给一次请求套上超时」—— 搜索这边两条链路(付费适配器链、内置免 Key 链)共用的那一小块。
 *
 * 需求:两条链路都要「这一家最多等 N 秒,超了就换下一家」,而实现里唯一容易写错的
 * 那一行是**超时只能中断这一家**。复制两份的代价不是多几行,是其中一份迟早会
 * 退化成 `deps.signal.abort()` —— 那等于用户的整轮对话被搜索超时掐断。
 *
 * 实现原样来自 `search/service.ts`(那里的注释一并跟过来),service 现在引这里。
 */

/**
 * 给一家套上超时。
 *
 * ★ 超时**只中断这一家**,不动 `outer` —— 那是整个 run 的中断信号,
 * abort 它等于把用户的整轮对话掐了。所以这里另起一个 controller,
 * 并把外面那个 signal 转发进来。
 */
export async function withTimeout<T>(
  outer: AbortSignal,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ctl = new AbortController()
  const onOuter = (): void => {
    ctl.abort(outer.reason)
  }
  if (outer.aborted) onOuter()
  outer.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => {
    ctl.abort(new Error('超时'))
  }, ms)
  // 定时器不该拖住进程退出
  timer.unref?.()
  try {
    return await fn(ctl.signal)
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onOuter)
  }
}
