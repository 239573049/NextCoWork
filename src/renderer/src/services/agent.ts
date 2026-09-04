/**
 * Agent 服务层 —— 组件不碰频道字符串(协议 §9)。
 *
 * 长任务的三段式(协议 §9):`invoke` 启动 + `on` 收进度 + `invoke` 中断。
 * 这里唯一值得注意的是 `startRun` 的调用契约,见下。
 */
import type { RunSnapshot } from '../../../shared/agent/event'
import type { RunRequest } from '../../../shared/agent/run-request'
import type { AgentEventEnvelope } from '../../../shared/ipc/contract'
import type { Unsubscribe } from '../../../shared/ipc/contract'
import { invoke, on } from './ipc'

/**
 * ★ 调用前必须先 mint runId 并订阅(方案 §3 规则 2)。
 *
 * 这个函数**不**返回 runId,是刻意的:如果它返回,调用点就会写成
 * `const id = await startRun(...)`,而 await 之后再订阅就已经晚了 ——
 * 首批 token 在 promise resolve 之前就发出去了。
 * 签名上拿不到 runId,这个错就写不出来。
 */
export function startRun(req: RunRequest): Promise<void> {
  return invoke('agent:run', req)
}

export function attachRun(runId: string, sinceSeq: number): Promise<RunSnapshot> {
  return invoke('agent:attach', { runId, sinceSeq })
}

export function abortRun(runId: string, cascade = true): Promise<void> {
  return invoke('agent:abort', { runId, cascade })
}

export function onAgentEvent(cb: (env: AgentEventEnvelope) => void): Unsubscribe {
  return on('agent:event', cb)
}
