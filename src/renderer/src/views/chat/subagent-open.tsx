/**
 * 「点开这个子代理」这个动作的传递口。
 *
 * ★ 为什么是 context 而不是一路往下传 prop:卡片挂在
 * `Thread → AssistantTurn → ToolTimeline → ToolGroup → SubagentNode` 的底部,
 * 而这个动作需要的两样东西(`workspace.id`、**父**会话的 sessionId)都在最顶上的
 * `ChatView` 手里。为了一个回调把 workspaceId 穿过四层纯展示组件,会让
 * `ToolTimeline` 从「把时间线摆好」变成「知道自己活在哪个工作区里」。
 *
 * ★ 默认值是 `undefined` 而不是一个空函数:卡片据此决定**画不画**那个可点的样子。
 * 没有 provider 的地方(单测、以后可能的只读引用)拿到的是一张纯展示卡片,
 * 而不是一张点了没反应的卡片。
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { SubagentState } from '../../../../shared/agent/transcript'

export type OpenSubagent = (state: SubagentState) => void

const SubagentOpenContext = createContext<OpenSubagent | undefined>(undefined)

export function SubagentOpenProvider({ open, children }: { open: OpenSubagent; children: ReactNode }): ReactNode {
  return <SubagentOpenContext.Provider value={open}>{children}</SubagentOpenContext.Provider>
}

export function useOpenSubagent(): OpenSubagent | undefined {
  return useContext(SubagentOpenContext)
}
