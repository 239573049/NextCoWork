/**
 * SSE 解析器 —— 方案 §1「自己写一份(约 60 行),两边共用」。
 *
 * 内核解上游的 SSE,网关(步骤 13)序列化出站的 SSE,两边对「一个事件长什么样」
 * 必须是同一份理解。
 *
 * ★ 这个文件的全部难度都在**分块边界**上,而那恰恰是肉眼测试永远看不到的:
 * 本机低延迟时一个 chunk 常常正好装下一整个事件,于是任何写法都「能跑」;
 * 上了真网络、或者上游开始发大 token,事件就开始被切碎 —— 表现是
 * 「偶尔少一个字」「偶尔工具参数 JSON 解析失败」。所以它有独立的单测。
 */

export interface SseEvent {
  /** `event:` 字段;缺省是 'message'(SSE 规范的默认事件名) */
  event: string
  /** 多行 `data:` 用 \n 连接后的结果 */
  data: string
  id?: string
}

/**
 * 增量解析器。喂进任意切分的字符串,吐出完整事件。
 *
 * 用类而不是生成器,是因为它有**跨调用的状态**(半行缓冲 + 半个事件),
 * 而生成器把这个状态藏起来之后就没法单独测「上一块留了什么」了。
 */
export class SseParser {
  /** 还没凑够一行的尾巴 */
  private buf = ''
  private dataLines: string[] = []
  private eventName = ''
  private lastId: string | undefined
  private sawBom = false

  feed(chunk: string): SseEvent[] {
    // BOM 只可能出现在流的最开头。不削掉的话第一个字段名会变成 "\ufeffevent",
    // 于是**整个第一个事件被当成未知字段丢掉** —— 而那正是 message_start。
    if (!this.sawBom) {
      this.sawBom = true
      if (chunk.startsWith('\ufeff')) chunk = chunk.slice(1)
    }

    this.buf += chunk
    const out: SseEvent[] = []
    let start = 0
    let i = 0

    while (i < this.buf.length) {
      const c = this.buf[i]
      if (c !== '\n' && c !== '\r') {
        i++
        continue
      }

      // ★ 缓冲区末尾的孤立 \r 不能当行尾处理 —— 它可能是被切开的 \r\n 的前半。
      // 当成行尾的话,紧跟着的 \n 下一块会被读成一个**空行**,
      // 而空行 = 事件边界,于是每个跨块的 \r\n 都会凭空劈出一个空事件。
      if (c === '\r' && i === this.buf.length - 1) break

      const line = this.buf.slice(start, i)
      i += c === '\r' && this.buf[i + 1] === '\n' ? 2 : 1
      start = i

      const ev = this.line(line)
      if (ev) out.push(ev)
    }

    this.buf = this.buf.slice(start)
    return out
  }

  /**
   * 流结束时调用。
   *
   * 规范说流末尾未以空行结束的数据要丢弃,但**上游经常这么干** ——
   * 最后一个 `data: [DONE]` 后面没有空行就关连接。丢掉它对我们没有坏处
   * (真正的终结信号是 message_stop 或 [DONE],两者我们都不依赖流的关闭),
   * 但把它交出来能让「上游少发了一个空行」不至于变成「最后一个事件丢了」。
   */
  flush(): SseEvent[] {
    const out: SseEvent[] = []
    if (this.buf.length > 0) {
      const ev = this.line(this.buf)
      if (ev) out.push(ev)
      this.buf = ''
    }
    const tail = this.dispatch()
    if (tail) out.push(tail)
    return out
  }

  private line(line: string): SseEvent | null {
    // 空行 = 事件边界
    if (line === '') return this.dispatch()
    // 注释行。上游拿它做心跳(OpenAI 发 `: keep-alive`),必须静默忽略 ——
    // 当成字段解析的话字段名会是空串,而空字段名在规范里也要忽略,
    // 所以写不写这一行结果一样;写出来是为了下一个人不必再想一遍。
    if (line.startsWith(':')) return null

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // 规范:冒号后**恰好一个**空格要去掉,多余的空格是数据的一部分
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        this.eventName = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      case 'id':
        // 规范:含 NUL 的 id 要忽略
        if (!value.includes('\0')) this.lastId = value
        break
      // 'retry' 我们不用:重试策略在 UpstreamRouter 里,由健康度决定,
      // 不该被上游一句 retry: 改写
      default:
        break
    }
    return null
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) {
      // 只有 event: 没有 data: 的事件按规范丢弃,但事件名要重置 ——
      // 否则它会粘到下一个事件上
      this.eventName = ''
      return null
    }
    const ev: SseEvent = {
      event: this.eventName === '' ? 'message' : this.eventName,
      data: this.dataLines.join('\n'),
      ...(this.lastId !== undefined ? { id: this.lastId } : {})
    }
    this.dataLines = []
    this.eventName = ''
    return ev
  }
}

/**
 * `Response` → SSE 事件流。
 *
 * ★ `TextDecoder({stream: true})` 不是可选的:一个多字节 UTF-8 字符
 * (中文正好是 3 字节)会横跨两个 chunk,逐块 `toString()` 会在接缝处产生
 * 一个 U+FFFD replacement character。症状是「中文回复里偶尔冒出一个 �」——
 * 而它出现的位置取决于网络分片,永远复现不了。
 */
export async function* sseFromResponse(
  res: Response,
  signal: AbortSignal
): AsyncGenerator<SseEvent> {
  const body = res.body
  if (!body) throw new Error('上游响应没有 body')

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseParser()
  const onAbort = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      // fetch 的 signal 会让 read() reject,但**已经在途的这一次 read 不会立刻回来**;
      // 显式检查一次,让中断在两次 read 之间也能生效
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      if (done) break
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) yield ev
    }
    // decode() 无参 = 冲掉解码器里残留的半个字符
    for (const ev of parser.feed(decoder.decode())) yield ev
    for (const ev of parser.flush()) yield ev
  } finally {
    signal.removeEventListener('abort', onAbort)
    // ★ 不 cancel 的话底层 socket 会一直挂着 —— 中断一个长回复后
    // 上游仍在给我们发 token,只是没人读了(方案 §4.7 末尾那条注释的同一个坑)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
