/**
 * 假发射器 —— 曾经是方案 §12 步骤 3 的驱动(「用 setInterval 假发射器驱动」),
 * **现在是 `agent-pump.test.ts` 的夹具**。生产路径已换成真 `AgentSession`
 * (见 `ipc/agent.ts` 的 `RunDriver`)。
 *
 * 它当初的价值在于**隔离验证**:接上真 Provider 之后,如果流式出问题,
 * 你需要知道锅在上游解码还是在 IPC/seq/store 投影这条链上 ——
 * 这个文件先把后者证明成对的。
 *
 * ★ 而它今天还留着,是因为**它对 RunHandle 的用法与真 AgentSession 完全一致** ——
 * emit / signal / finish 三件事,一个不多。当初这让「换掉」只是换一个调用;
 * 现在这让泵测试能在一个**时序完全确定**的驱动上跑,而不必让合批窗口
 * 去赌真上游怎么切片。留着它比留一堆 `vi.mock` 便宜。
 *
 * 零 electron import(和整个 kernel/ 一样)。
 */
import { assistantMessage } from '../../shared/agent/message'
import type { ContentPart } from '../../shared/agent/message'
import type { RunRequest } from '../../shared/agent/run-request'
import { prefixedId, ulid } from '../../shared/util/id'
import type { RunHandle } from './run-registry'

/** 每个 delta 之间的间隔。太快看不出流式,太慢等得烦。 */
const TICK_MS = 28

/**
 * ⚠️ 28ms > 合批泵的 16ms 时间窗,所以**假发射器跑起来时合批从不生效** ——
 * 每个 delta 单独成一批。这不是 bug(它就是要慢得能看清打字),
 * 但意味着它验证的是「泵按序推、不丢、不重」,**不是**合批本身。
 *
 * 真上游是相反的形状:一个 TCP 包里常带来几十个 delta。合批那条路径由
 * `agent-pump.test.ts` 里手动灌 200 个 delta 的突发用例覆盖,别指望这里。
 */

const OPENING = [
  '好的,我来看一下这个问题。',
  '\n\n先读一下工程结构,确认几个文件的位置。'
]
const CLOSING = [
  '\n\n从目录结构看,这是一个 electron-vite 工程:',
  '主进程在 `src/main/`,渲染层在 `src/renderer/`,',
  '两边共享 `src/shared/` 下的类型与纯函数。',
  '\n\n需要我展开哪一部分?'
]

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 跑一段脚本化的流。
 *
 * 刻意覆盖了几个**容易在实现时被忽略、出问题又很难定位**的形状:
 * - 一条消息里有**多个内容块**(文本 → 工具调用 → 文本),index 分别是 0/1/2;
 * - 工具调用的参数**分片到达**(验证 ToolCallAccumulator 与 UI 的拼装);
 * - `message_commit` 在 `run_end` **之前**(它是落盘边界,也是日志裁剪点);
 * - `context_usage` 每轮一条(UI 的上下文压力条)。
 */
export async function runFake(handle: RunHandle, req: RunRequest): Promise<void> {
  const { signal } = handle
  const parts: ContentPart[] = []

  try {
    handle.emit({ type: 'stream', delta: { type: 'message_start', model: req.model } })

    // ── 块 0:开场白 ──
    let text = ''
    for (const chunk of OPENING) {
      for (const ch of chunk) {
        await sleep(TICK_MS, signal)
        text += ch
        handle.emit({ type: 'stream', delta: { type: 'text_delta', index: 0, text: ch } })
      }
    }
    parts.push({ type: 'text', text })

    // ── 块 1:工具调用,参数分片到达 ──
    const callId = prefixedId('call')
    const input = { path: '.', depth: 2 }
    handle.emit({
      type: 'stream',
      delta: { type: 'tool_call_start', index: 1, callId, name: 'list_files' }
    })
    for (const argsDelta of ['{"path"', ':".","de', 'pth":2}']) {
      await sleep(TICK_MS, signal)
      handle.emit({ type: 'stream', delta: { type: 'tool_call_delta', index: 1, callId, argsDelta } })
    }
    handle.emit({ type: 'stream', delta: { type: 'tool_call_end', index: 1, callId } })
    parts.push({ type: 'tool_call', callId, name: 'list_files', input })

    handle.emit({ type: 'tool_start', callId, toolName: 'list_files', input })
    await sleep(TICK_MS * 6, signal)
    // 进度事件是**易失的**,永不进转录(方案 §4.3)
    handle.emit({
      type: 'tool_progress',
      callId,
      progress: { callId, message: '扫描 src/ …', fraction: 0.5 }
    })
    await sleep(TICK_MS * 6, signal)
    const output = { content: 'src/main/\nsrc/preload/\nsrc/renderer/\nsrc/shared/' }
    handle.emit({ type: 'tool_end', callId, output, isError: false })
    parts.push({ type: 'tool_result', callId, output, isError: false })

    // ── 块 2:结论 ──
    text = ''
    for (const chunk of CLOSING) {
      for (const ch of chunk) {
        await sleep(TICK_MS, signal)
        text += ch
        handle.emit({ type: 'stream', delta: { type: 'text_delta', index: 2, text: ch } })
      }
    }
    parts.push({ type: 'text', text })

    handle.emit({
      type: 'stream',
      delta: {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 1287, outputTokens: 214 }
      }
    })

    // ★ 落盘边界。也是日志裁剪点 —— 它之前的 delta 从此是冗余的。
    handle.emit({
      type: 'message_commit',
      message: assistantMessage(ulid(), parts, Date.now())
    })
    handle.emit({ type: 'context_usage', used: 1501, window: 200_000, shouldCompact: false })
    handle.finish('done')
  } catch (err) {
    // AbortError 是**正常路径**(用户点了停止),不是故障。
    if (signal.aborted) {
      // 真 AgentSession 在这里还要做方案 §4.8 的第 4 件事:
      // 给未闭合的 tool_call 补 tool_result。假发射器没有转录要维护,
      // 所以只有状态转移 —— 但那一步不能忘,漏了下一轮请求就是 400。
      handle.finish('aborted')
      return
    }
    handle.finish('error', {
      code: 'unknown',
      message: err instanceof Error ? err.message : String(err),
      retryable: false
    })
  }
}
