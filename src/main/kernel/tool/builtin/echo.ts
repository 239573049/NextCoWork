/**
 * `echo` —— 步骤 4 的工具层试金石。
 *
 * 它什么也不做,这正是重点:它让「模型发起 tool_use → session 执行 →
 * tool_result 回填 → 模型继续」这条链路可以在**没有文件系统、没有网络、
 * 没有权限弹窗**的情况下端到端跑通。真正的 fs / bash 工具是步骤 9。
 *
 * 真实工具会替换掉它,但**这条链路的形状不会变** —— 所以 echo 也老老实实
 * 走 `defineTool`(校验入参)、发进度、认 signal。夹具走捷径的话,
 * 第一个真工具就会撞上这里本该暴露的问题。
 */
import { z } from 'zod'
import { toolOk } from '../../../../shared/agent/tool'
import { defineTool } from '../define'
import type { ToolRegistration } from '../registry'

const EchoInput = z.object({
  text: z.string().describe('The text to echo back'),
  /** 用来验证中断真的穿透到了工具体内 —— 没有这个参数就没法测中断路径 */
  delayMs: z.number().int().min(0).max(60_000).optional().describe('Milliseconds to wait before echoing. Defaults to 0')
})

/** 可中断的 sleep。工具里所有的等待都必须长这样,否则 abort 会留下僵尸。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const echoTool: ToolRegistration = defineTool({
  internalId: 'echo',
  description: 'Returns the text you pass in, unchanged. Used to verify that the tool-call path works.',
  schema: EchoInput,
  readOnly: true,
  destructive: false,
  needsNetwork: false,
  async run(input, ctx) {
    if (input.delayMs !== undefined && input.delayMs > 0) {
      ctx.emit({ callId: ctx.callId, message: `等待 ${input.delayMs}ms` })
      await sleep(input.delayMs, ctx.signal)
    }
    return toolOk(input.text)
  }
})
