/**
 * 「这个异常是不是中断?」—— 只答一次。
 *
 * 上游层(SSE 读取被 cancel)和工具层(execute 里的 fetch/spawn 被 cancel)
 * 都要问这个问题,而两边给出不同答案时的症状是:中断后 UI 上弹一个假的
 * 「网络错误」,或者反过来,一个真的网络错误被当成中断静默吞掉。
 */
export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true
  // node 的 AbortError 不是 DOMException;undici 抛的是 `TypeError: fetch failed`
  // 套一个 AbortError cause。所以既看 name 也看 message,再看一层 cause。
  if (e instanceof Error) {
    if (e.name === 'AbortError' || /abort/i.test(e.message)) return true
    if (e.cause !== undefined && e.cause !== e) return isAbortError(e.cause)
  }
  return false
}

/**
 * 全项目唯一的 `new DOMException(..., 'AbortError')`。
 *
 * 抛中断的地方有四处(SSE 读取、重试退避、工具执行、演示上游的分片),
 * 而 `isAbortError` 认的是 **name**。各处自己 new 的话,某一处把 name 写成
 * `'Abort'` 就会静默降级成一个假的「网络错误」—— 编译器不会说话,
 * 因为那个字符串在类型上完全合法。
 */
export function abortError(message = 'aborted'): DOMException {
  return new DOMException(message, 'AbortError')
}

/** 可中断的 sleep。上游的重试退避与演示上游的分片节奏共用同一份。 */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
