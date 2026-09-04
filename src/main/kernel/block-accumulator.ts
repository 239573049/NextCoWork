/**
 * BlockAccumulator —— 把归一化事件流拼回 `ContentPart[]`。
 *
 * `AgentSession` 从上游收到的是一串按 `index` 分块的增量(方案 §4.2),
 * 而要落盘、要回传给下一轮的是块数组(§4.1)。这个文件就是这一次转换。
 *
 * 单独成文件的理由和 `ContextAssembler` 一样:它是**纯的**(事件进、块出,
 * 不读时钟、不碰 I/O、不发事件),而 session 是不纯的。混在一起的话,
 * 「未闭合的工具调用该怎么办」这条规则就只能顺带被测到,而它恰恰是
 * 中断路径上最容易错的一条。
 */
import type { ContentPart } from '../../shared/agent/message'
import { ToolCallAccumulator, type ProviderStreamEvent } from '../../shared/agent/stream'

interface TextBlock {
  kind: 'text'
  text: string
}
interface ThinkingBlock {
  kind: 'thinking'
  text: string
  opaque?: unknown
}
interface CallBlock {
  kind: 'tool_call'
  callId: string
  name: string
  /** undefined = 还没收到 `tool_call_end`。见 `finalize` 里对未闭合块的处理。 */
  done?: { ok: true; input: unknown } | { ok: false; raw: string; reason: string }
}
type Block = TextBlock | ThinkingBlock | CallBlock

/**
 * 一次待执行的工具调用。
 *
 * ★ 刻意做成判别联合而不是「`input` 加一个可选的 `parseError`」:
 * 参数解析失败是**必须处理**的分支(要产出一个工具错误让模型自己改),
 * 而可选字段是可以忘记读的。
 */
export type PendingCall =
  | { ok: true; callId: string; name: string; input: unknown }
  | { ok: false; callId: string; name: string; raw: string; reason: string }

export interface AccumulatedTurn {
  /** 提交进转录的助手消息内容;可能为空(模型一个字都没来得及吐) */
  parts: ContentPart[]
  /** 本轮要执行的工具调用,与 `parts` 里的 `tool_call` 块一一对应 */
  calls: PendingCall[]
}

export class BlockAccumulator {
  /** index → 块。**顺序按 index 排**,不按到达顺序 —— 见 `finalize`。 */
  private readonly blocks = new Map<number, Block>()
  /** 参数的累积与解析语义(空参数、只 parse 一次)复用 shared 里那一份 */
  private readonly args = new ToolCallAccumulator()

  apply(e: ProviderStreamEvent): void {
    switch (e.type) {
      case 'text_delta': {
        const b = this.blocks.get(e.index)
        if (b === undefined) this.blocks.set(e.index, { kind: 'text', text: e.text })
        else if (b.kind === 'text') b.text += e.text
        // 类型不匹配 = 上游把两种块塞进了同一个 index(畸形流)。丢掉这个增量,
        // **不覆盖已有块** —— 覆盖会毁掉一个进行中的 tool_call,凭空制造孤儿。
        break
      }

      case 'thinking_delta': {
        const b = this.blocks.get(e.index)
        if (b === undefined) this.blocks.set(e.index, { kind: 'thinking', text: e.text })
        else if (b.kind === 'thinking') b.text += e.text
        break
      }

      case 'block_opaque': {
        const b = this.blocks.get(e.index)
        if (b === undefined) {
          /**
           * ★ `redacted_thinking` 整块不透明,**一个 delta 都没有**
           * (见 decode/anthropic.ts)。所以 opaque 事件必须能**凭自己把块建出来**,
           * 否则那一块就在这里蒸发,下一轮回传时思考链是断的。
           */
          this.blocks.set(e.index, { kind: 'thinking', text: '', opaque: e.opaque })
        } else if (b.kind === 'thinking') {
          // 正常路径:thinking 块的 signature 在 content_block_stop 时才到齐
          b.opaque = e.opaque
        }
        break
      }

      case 'tool_call_start':
        // 唯一会**替换**同 index 已有块的事件:它来自 `content_block_start`,
        // 是上游对这个 index 的一次显式声明,而增量只是延续 —— 延续不该重定义。
        this.blocks.set(e.index, { kind: 'tool_call', callId: e.callId, name: e.name })
        this.args.start(e.callId, e.name)
        break

      case 'tool_call_delta':
        this.args.delta(e.callId, e.argsDelta)
        break

      case 'tool_call_end': {
        const b = this.blocks.get(e.index)
        // 没见过 start 就来的 end:无从知道工具名,只能丢。编一个出来更糟 ——
        // 编出的 callId 回传时不匹配任何 tool_use,直接 400。
        if (b?.kind !== 'tool_call') break
        const r = this.args.end(e.callId)
        b.done = r.ok ? { ok: true, input: r.input } : { ok: false, raw: r.raw, reason: r.reason }
        break
      }

      // message_start / message_end / provider_retry / provider_switch / error
      // 都不产生内容块 —— 它们由 session 直接消费。
      default:
        break
    }
  }

  /**
   * 收尾。**只读**,可以重复调用 —— 中断路径会在 session 的 catch 里调它,
   * 而那时 `apply` 可能停在任何一个位置上。
   *
   * ★ **未闭合的 `tool_call` 块一律丢弃,没有第二种选项。**
   *
   * 依据是 §4.2 的 adapter 契约:「**必须**发 `tool_call_start … tool_call_end`;
   * 中间的 delta 数量可以为 0」。所以缺了 end 只有一个含义 ——
   * **模型还在写这个调用,它还不是一次调用**。
   *
   * 正常路径上这条规则是空转(end 一定会来);它真正生效在中断和流中途报错时,
   * 而那两处保留半截调用的后果都很具体:参数是残缺 JSON,执行它等于按模型
   * 没写完的意图动手;不执行又留下一个孤儿 tool_use,下一轮直接 400。
   */
  finalize(): AccumulatedTurn {
    const parts: ContentPart[] = []
    const calls: PendingCall[] = []

    // 按 index 排序而不是按到达顺序:块的先后是**模型表达的顺序**,
    // 而事件到达顺序在并行工具调用时可以交错。
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0])

    for (const [, b] of ordered) {
      switch (b.kind) {
        case 'text':
          // 空 text 块上行就是 400(`text content blocks must be non-empty`)
          if (b.text !== '') parts.push({ type: 'text', text: b.text })
          break

        case 'thinking':
          // 空正文但有 opaque 的是 redacted_thinking —— 那正是要原样搬运的东西
          if (b.text !== '' || b.opaque !== undefined) {
            parts.push({
              type: 'thinking',
              text: b.text,
              ...(b.opaque !== undefined ? { opaque: b.opaque } : {})
            })
          }
          break

        case 'tool_call': {
          if (b.done === undefined) break // ★ 未闭合 —— 见方法头
          if (b.done.ok) {
            parts.push({ type: 'tool_call', callId: b.callId, name: b.name, input: b.done.input })
            calls.push({ ok: true, callId: b.callId, name: b.name, input: b.done.input })
          } else {
            /**
             * ★ 参数解析失败时,`tool_call` 块**照样进转录**(入参用空对象占位)。
             *
             * 两个块必须同时存在:少了 tool_call,紧接着那条 tool_result 就没有配对的
             * tool_use;少了 tool_result,这个 tool_use 就是孤儿。**两个方向都是 400。**
             * 原文由 session 放进 tool_result 里回给模型 —— 它才知道自己写错了什么。
             */
            parts.push({ type: 'tool_call', callId: b.callId, name: b.name, input: {} })
            calls.push({
              ok: false,
              callId: b.callId,
              name: b.name,
              raw: b.done.raw,
              reason: b.done.reason
            })
          }
          break
        }
      }
    }

    return { parts, calls }
  }
}
