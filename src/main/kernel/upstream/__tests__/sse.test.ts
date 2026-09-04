import { describe, expect, it } from 'vitest'
import { SseParser, sseFromResponse, type SseEvent } from '../sse'

/**
 * 这些用例几乎全是**分块边界**的用例,因为那是 SSE 解析唯一真正难的地方 ——
 * 而本机开发时一个 chunk 常常正好装下一整个事件,于是错误的实现也「能跑」。
 */

function feedAll(parser: SseParser, chunks: string[]): ReturnType<SseParser['feed']> {
  const out: ReturnType<SseParser['feed']> = []
  for (const c of chunks) out.push(...parser.feed(c))
  out.push(...parser.flush())
  return out
}

/** 把一段完整的 SSE 文本按每 n 个字符切开 —— 模拟网络分片 */
function slice(text: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n))
  return out
}

describe('SseParser', () => {
  it('解析基本事件', () => {
    const evs = feedAll(new SseParser(), ['event: message_start\ndata: {"a":1}\n\n'])
    expect(evs).toEqual([{ event: 'message_start', data: '{"a":1}' }])
  })

  it('缺省事件名是 message(SSE 规范)', () => {
    const evs = feedAll(new SseParser(), ['data: hello\n\n'])
    expect(evs).toEqual([{ event: 'message', data: 'hello' }])
  })

  /**
   * ★ 核心用例:**逐字符**喂进去,结果必须和一次性喂完全一致。
   * 这一条挂掉,就意味着存在某个分片位置会让事件丢失或劈裂 ——
   * 而真实网络会替我们找到那个位置。
   */
  it('任意分片位置都得到相同结果', () => {
    const text =
      'event: a\ndata: {"x":1}\n\n' +
      ': keep-alive\n\n' +
      'event: b\ndata: line1\ndata: line2\n\n' +
      'id: 42\nevent: c\ndata: {"y":2}\n\n'
    const whole = feedAll(new SseParser(), [text])
    expect(whole).toHaveLength(3)

    for (const n of [1, 2, 3, 5, 7, 13, 64]) {
      expect(feedAll(new SseParser(), slice(text, n)), `分片大小 ${n}`).toEqual(whole)
    }
  })

  /**
   * ★ 回归:\r\n 被切在中间。
   *
   * 天真实现会把块尾的 \r 当行尾,于是下一块开头的 \n 变成一个**空行**,
   * 而空行 = 事件边界 → 每个跨块的 \r\n 都凭空劈出一个空事件。
   * 症状是「事件数量对不上,但每个事件的内容都是对的」。
   */
  it('\\r\\n 被切开时不产生幽灵事件', () => {
    const p = new SseParser()
    const out = [...p.feed('data: hi\r'), ...p.feed('\n\r\n'), ...p.flush()]
    expect(out).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('\\r\\n / \\n / \\r 三种行尾都认', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const evs = feedAll(new SseParser(), [`data: x${eol}${eol}`])
      expect(evs, `行尾 ${JSON.stringify(eol)}`).toEqual([{ event: 'message', data: 'x' }])
    }
  })

  /**
   * ★ 回归:BOM。不削掉的话第一个字段名是 "\ufeffevent",
   * 整个第一个事件被当成未知字段丢掉 —— 而那正好是 message_start。
   */
  it('削掉流开头的 BOM', () => {
    const evs = feedAll(new SseParser(), ['\ufeffevent: first\ndata: 1\n\n'])
    expect(evs).toEqual([{ event: 'first', data: '1' }])
  })

  it('BOM 只在开头削,正文里的 \\uFEFF 不动', () => {
    const evs = feedAll(new SseParser(), ['data: a\ufeffb\n\n'])
    expect(evs[0]?.data).toBe('a\ufeffb')
  })

  it('冒号后只去掉一个空格,多余的空格是数据', () => {
    const evs = feedAll(new SseParser(), ['data:  两个空格\n\n', 'data:零个空格\n\n'])
    expect(evs.map((e) => e.data)).toEqual([' 两个空格', '零个空格'])
  })

  it('注释行(心跳)被静默忽略', () => {
    const evs = feedAll(new SseParser(), [': ping\n', ':\n', 'data: real\n\n'])
    expect(evs).toEqual([{ event: 'message', data: 'real' }])
  })

  it('多行 data 用 \\n 连接', () => {
    const evs = feedAll(new SseParser(), ['data: a\ndata: b\ndata: c\n\n'])
    expect(evs[0]?.data).toBe('a\nb\nc')
  })

  /** 只有 event: 没有 data: 的事件按规范丢弃,但事件名**不能粘到下一个事件上** */
  it('无 data 的事件被丢弃且不污染下一个事件', () => {
    const evs = feedAll(new SseParser(), ['event: ghost\n\n', 'data: real\n\n'])
    expect(evs).toEqual([{ event: 'message', data: 'real' }])
  })

  it('id 跨事件保持,含 NUL 的 id 被忽略', () => {
    const p = new SseParser()
    const a = p.feed('id: 7\ndata: x\n\n')
    const b = p.feed('data: y\n\n')
    const c = p.feed('id: bad\0id\ndata: z\n\n')
    expect(a[0]?.id).toBe('7')
    expect(b[0]?.id).toBe('7')
    expect(c[0]?.id).toBe('7')
  })

  /** 上游经常在最后一个事件后直接关连接,不发那个空行 */
  it('flush 交出末尾未以空行结束的事件', () => {
    const p = new SseParser()
    expect(p.feed('data: tail')).toEqual([])
    expect(p.flush()).toEqual([{ event: 'message', data: 'tail' }])
  })

  it('flush 之后再无残留', () => {
    const p = new SseParser()
    p.feed('data: tail')
    p.flush()
    expect(p.flush()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────

function bodyOf(bytes: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(b)
        c.close()
      }
    })
  )
}

describe('sseFromResponse', () => {
  it('从 Response 读出事件', async () => {
    const res = bodyOf([new TextEncoder().encode('event: a\ndata: 1\n\n')])
    const out: SseEvent[] = []
    for await (const ev of sseFromResponse(res, new AbortController().signal)) out.push(ev)
    expect(out).toEqual([{ event: 'a', data: '1' }])
  })

  /**
   * ★ 回归:多字节字符横跨 chunk。
   *
   * 中文在 UTF-8 里是 3 字节。逐块 `Buffer.toString()` 会在接缝处产生一个
   * U+FFFD(�)。症状是「中文回复里偶尔冒出一个 �」,位置取决于网络分片,
   * 永远复现不了 —— 所以只能在这里钉住。
   */
  it('多字节 UTF-8 横跨 chunk 不产生 U+FFFD', async () => {
    const full = new TextEncoder().encode('data: 你好世界\n\n')
    // 在第一个汉字的 3 个字节中间切开
    const cut = 'data: '.length + 1
    const res = bodyOf([full.slice(0, cut), full.slice(cut)])

    const out: SseEvent[] = []
    for await (const ev of sseFromResponse(res, new AbortController().signal)) out.push(ev)
    expect(out).toEqual([{ event: 'message', data: '你好世界' }])
    expect(out[0]?.data).not.toContain('�')
  })

  it('已中断的 signal 立刻抛 AbortError', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = bodyOf([new TextEncoder().encode('data: 1\n\n')])
    await expect(async () => {
      for await (const _ of sseFromResponse(res, ac.signal)) void _
    }).rejects.toThrow(/abort/i)
  })

  /** 中断后底层 reader 必须被 cancel,否则 socket 一直挂着,上游还在给我们发 token */
  it('提前退出时取消底层 reader', async () => {
    let cancelled = false
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'))
        },
        cancel() {
          cancelled = true
        }
      })
    )
    for await (const _ of sseFromResponse(res, new AbortController().signal)) {
      void _
      break // for-await + break 会调用 generator 的 .return() → 走 finally
    }
    expect(cancelled).toBe(true)
  })
})
