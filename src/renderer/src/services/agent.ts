/**
 * Agent 服务层 —— 组件不碰频道字符串(协议 §9)。
 *
 * 长任务的三段式(协议 §9):`invoke` 启动 + `on` 收进度 + `invoke` 中断。
 * 这里唯一值得注意的是 `startRun` 的调用契约,见下。
 */
import type { ActiveRunEntry, RunSnapshot } from '../../../shared/agent/event'
import type { RunRequest } from '../../../shared/agent/run-request'
import type { InteractionResponse, PendingInteraction } from '../../../shared/agent/interaction'
import type { InterjectItem } from '../../../shared/agent/interject'
import type { PermissionMode } from '../../../shared/agent/permission'
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

/**
 * 把当前**全部**已引入(promoted)的排队条目同步给正在跑的 run。
 *
 * ★ 全量而不是增量 —— 见 `agent:interject` 的契约注释。调用点因此可以粗放:
 * 任何会改变 promoted 集合的操作(引入、取消、编辑、删除)结束后调一次即可,
 * 不必各自算出「这次变了哪一条」。
 */
export function interjectRun(runId: string, items: InterjectItem[]): Promise<void> {
  return invoke('agent:interject', { runId, items })
}

/**
 * 权限档位药丸切换时,把新档位立刻推给这个正在跑的 run——见 `agent:setPermissionMode`
 * 的契约注释。run 已经不在跑了会被主进程静默忽略,这里不必特殊处理。
 */
export function setRunPermissionMode(runId: string, mode: PermissionMode): Promise<void> {
  return invoke('agent:setPermissionMode', { runId, mode })
}

export function onAgentEvent(cb: (env: AgentEventEnvelope) => void): Unsubscribe {
  return on('agent:event', cb)
}

/**
 * 「现在还有哪些顶层 run 活着」的权威集合。
 *
 * ★ 和 `onAgentEvent` 是两条路,不要合并:那条按 run 订阅定向推送,没人订阅
 * 就整批丢弃(定时任务的 run、⌘R 之后还没打开的会话都属于这一类);
 * 这条是广播,专门用来让运行中角标**在丢过消息之后依然收敛**。
 */
export function onActiveRuns(cb: (entries: readonly ActiveRunEntry[]) => void): Unsubscribe {
  return on('agent:activeRuns', ({ runs }) => cb(runs))
}

export function listInteractions(runId?: string, sessionId?: string): Promise<PendingInteraction[]> {
  return invoke('agent:listInteractions', { runId, sessionId })
}

export function respondInteraction(response: InteractionResponse): Promise<void> {
  return invoke('agent:respondInteraction', response)
}
