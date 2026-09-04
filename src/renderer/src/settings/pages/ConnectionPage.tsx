/**
 * 「连接」页 —— 只是个分发器,七个子页各在 `pages/connection/` 下。
 *
 * ★ **`sub` 的取值由 `nav.ts` 的 `connection.subs` 定义,这里不重复列一遍常量。**
 * 两处各写一份的话,`nav.ts` 里加一项而这里忘了加,表现是点过去一片空白 ——
 * 所以这里用 `default` 兜住,兜到的是「连接器 / 插件 / 机器人对话」那三页
 * 共用的说明页,它自己按 sub 查文案。
 *
 * 三块**真接上运行时**的:MCP(连真服务器、工具进 ToolRegistry)、
 * 搜索服务(八家、Key 进 safeStorage、`web_search` 按优先级切换)、
 * 网络(真的作用于 `session.defaultSession.setProxy`)。开放网关的三个开关
 * 也是真落库的,只是 HTTP 壳本身还没监听 —— 那一页照实标着步骤 13。
 */
import type { ReactNode } from 'react'
import type { SettingsPageProps } from '../props'
import { GatewayPane } from './connection/GatewayPane'
import { McpPane } from './connection/McpPane'
import { NetworkPane } from './connection/NetworkPane'
import { NotPlannedPane } from './connection/NotPlannedPane'
import { SearchPane } from './connection/SearchPane'

export function ConnectionPage(props: SettingsPageProps): ReactNode {
  switch (props.sub) {
    case 'mcp':
      return <McpPane />
    case 'search':
      return <SearchPane />
    case 'gateway':
      return <GatewayPane {...props} />
    case 'network':
      return <NetworkPane {...props} />
    default:
      return <NotPlannedPane sub={props.sub} />
  }
}
