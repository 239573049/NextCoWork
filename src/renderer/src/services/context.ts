import type { ContextCheckpoint, ContextPreview } from '../../../shared/agent/context-management'
import type { ContextPreviewRequest } from '../../../shared/ipc/contract'
import { invoke } from './ipc'

export function listContextCheckpoints(sessionId: string): Promise<ContextCheckpoint[]> {
  return invoke('context:list', { sessionId })
}

export function updateContextCheckpoint(checkpointId: string, note: string, revision: number): Promise<ContextCheckpoint> {
  return invoke('context:updateCheckpoint', { checkpointId, note, revision })
}

/** 手动压缩上下文。返回新检查点，以及压缩后估算的输入 token。 */
export function compactContext(sessionId: string): Promise<{ checkpoint: ContextCheckpoint; inputTokens: number }> {
  return invoke('context:compact', { sessionId })
}

/**
 * 还没发过请求时的占用归因 —— 主进程装配一次但不发出去。
 *
 * ★ 在**菜单打开时**拉,不在挂载时拉:它每次都要把系统提示词和整份工具清单
 * 重新估一遍,而绝大多数会话从头到尾都不会有人点开那个圆环。
 */
export function previewContext(req: ContextPreviewRequest): Promise<ContextPreview | undefined> {
  return invoke('context:preview', req)
}
