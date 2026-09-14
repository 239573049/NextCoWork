/**
 * 「此刻在干什么」—— 把转录投影成状态行那一句话的**相位**。
 *
 * ★ **为什么不是直接读 `status`。** `RunStatus` 只有 running/done/error/aborted 四档,
 * 一次 run 里绝大部分时间都卡在 `running` 上不动;而这段时间里 Agent 其实在
 * 读文件、跑命令、连网、派子代理之间来回切。状态行拿 `running` 只能写「运行中」,
 * 那句话从第一个工具到第十个工具一个字都不变 —— 界面上唯一在动的信息,
 * 恰恰是它没有表达的那一维。
 *
 * ★ **纯函数,不碰 store,单测穷尽。** 它的 bug 形态是「并行跑三个工具时选错了那个」,
 * 依赖工具的具体到达顺序才现形,靠盯屏幕复现不了 —— 和 `tool-timeline.ts`
 * 抬头说的是同一条理由。
 *
 * ★ 产出**只喂给装饰性文案**。真正的状态仍然是 `data-status` 上那四档,
 * e2e 探针读的是它;这里换多少个词都不该让任何一条断言动。
 */
import type { TranscriptState } from '../agent/transcript'
import { presenterOf, type ToolShape } from './tool-presenter'

/**
 * 工具的八种形态 + 三种「没有工具在跑」的时刻。
 *
 * 复用 `ToolShape` 而不是另起一套分类:那边已经按「展开后长什么样」把工具分完了,
 * 而**用户看到的是同一批分组**(时间线的折叠标题也用它)。再分一套的话,
 * 状态行说「在检索」而时间线把那次调用归进「读取」,两处对不上。
 */
export type ActivityPhase = ToolShape | 'waiting' | 'writing' | 'working'

/**
 * @param waitingForResponse 首字节还没到(调用方已有的判定,不在这里重算)
 */
export function activityOf(transcript: TranscriptState, waitingForResponse: boolean): ActivityPhase {
  /*
    ★ **并行跑多个工具时,取最新开跑的那个。** 一次助手轮次里同时挂三五个工具是常态;
    取第一个的话,那句文案会在头一个慢工具跑完之前一直停在它上面 ——
    而用户刚刚在时间线上看到新增的是最后那一行。

    `startedAt` 可能缺失(旧转录重放,见 `ToolCallState.startedAt`)。缺的按 0 算,
    于是它只会输给任何一个有戳的;全都没戳时退化成插入序的最后一个,
    那正是 `Object.values` 的顺序。
  */
  let latest: { at: number; name: string } | undefined
  for (const call of Object.values(transcript.tools)) {
    if (call.status !== 'running') continue
    const at = call.startedAt ?? 0
    if (latest === undefined || at >= latest.at) latest = { at, name: call.name }
  }
  if (latest !== undefined) return presenterOf(latest.name).shape

  /*
    没有工具在跑的三种时刻。看**最后一个** live 块:前面那些已经流完了,
    此刻在动的是最后这个。
    `tool_use` 是参数 JSON 还在流、工具尚未开跑 —— 它既不算「在想」也不算「在读文件」,
    归到通用那档,免得文案抢在工具之前就开始描述一件还没发生的事。
  */
  const block = transcript.live.at(-1)
  if (block?.kind === 'thinking') return 'reasoning'
  if (block?.kind === 'text') return 'writing'
  if (block?.kind === 'tool_use') return 'working'

  return waitingForResponse ? 'waiting' : 'working'
}
