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

export function abortable<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const fail = (error: unknown): void => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = (): void => { queueMicrotask(() => fail(abortError())) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      Promise.resolve(operation()).then((value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }, fail)
    } catch (error) {
      fail(error)
    }
  })
}

export async function* abortableStream<T>(
  source: AsyncIterable<T>, signal: AbortSignal
): AsyncIterable<T> {
  signal.throwIfAborted()
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  try {
    for (;;) {
      const next = await abortable(() => iterator.next(), signal)
      signal.throwIfAborted()
      if (next.done) {
        completed = true
        return
      }
      yield next.value
    }
  } finally {
    const close = iterator.return
    if (!completed && close !== undefined) {
      if (signal.aborted) void Promise.resolve().then(() => close.call(iterator)).catch(() => {})
      else await abortable(() => close.call(iterator), signal)
    }
  }
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

/**
 * 给一次外部调用一个**墙钟上限** —— 超时即 **abort**,不只是「不等了」。
 *
 * ★ 与 `abortable` 的分工:`abortable` 把一个已有的 signal 转成 promise 的拒绝
 * (谁来 abort 是别人的事);这里是**自己造那个 abort**,因为没有别人会造 ——
 * 外部调用卡住的时候,没有任何人在看着它。
 *
 * ★ 为什么不能只 race 不 abort:race 赢了只说明「我们不等了」,远端那次调用还在跑。
 * 这正是 `mcp/bridge.ts` 注释里担心的那件事 —— 界面停了,PR 还是被建完了。
 * 所以 `operation` 收到的是**本函数自己那个 controller 的 signal**,超时会真的
 * 传进去。race 仍然保留,是因为不是每个被调方都认 signal(MCP SDK 的
 * `client.connect` 就不收),那时至少我们这边能脱身。
 *
 * 超时抛的是一个**普通 Error**,不是 `AbortError` —— 两者对调用方意味着完全不同
 * 的事:用户按停止是「不必再说了」,超时是「对面没反应」,后者要进转录让模型看见
 * 并换条路。`isAbortError` 认的是 name,所以这里刻意不用 `abortError()`。
 *
 * @param outer 外层的中断(通常是 `ctx.signal`)。转发进去,这样用户按停止时
 *              被调方同样收得到 —— 两个来源共用一个 controller。
 */
export function withDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  ms: number,
  what: string,
  outer?: AbortSignal
): Promise<T> {
  if (outer?.aborted === true) return Promise.reject(abortError())
  const controller = new AbortController()
  const forward = (): void => controller.abort(abortError())
  outer?.addEventListener('abort', forward, { once: true })

  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`${what}超时(超过 ${String(ms / 1000)} 秒)`)
      controller.abort(err)
      reject(err)
    }, ms)
    timer = t
    // 正常路径下别让这个定时器把进程按住不退
    if (typeof t.unref === 'function') t.unref()
  })

  // 同步抛出的 operation 也要变成一次拒绝,而不是把 race 整个掀掉
  const run = (async () => operation(controller.signal))()
  return Promise.race([run, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  })
}
