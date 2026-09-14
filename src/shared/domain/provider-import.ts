/**
 * 「从其他应用导入提供商」这条路的跨进程类型。
 *
 * ★ 这里刻意**只有元数据,没有任何密钥**。源侧(Claude Code env、Codex/OpenCode
 * 配置)里的 token / apiKey 一律不进这个类型 —— `hasLocalKey` 只回一个布尔,
 * 让界面能提示「源侧配过 key,导进来后你要重新填」,而值绝不过 IPC。
 *
 * 落地时(渲染层)用 `customProviderDraft` 生成真正的 `custom-` 提供商,
 * 所以这里带的是 `UpstreamProtocol`(anthropic / openai-chat / openai-responses),
 * 不是源侧的 `wire_api` / `npm` 这类各家私有字段 —— 归一在主进程一次做完。
 */
import type { UpstreamProtocol } from './provider'
import type { ImportDiagnostic, ImportSourceKind } from './import'

export interface ImportableProvider {
  /** 源内稳定唯一键(列表 key / 去重用)。 */
  sourceKey: string
  /** 展示名。用户内容,不翻译。 */
  name: string
  protocol: UpstreamProtocol
  /** 已脱敏的 base URL。★ 空串 = 源侧没给,该项**不可导入**。 */
  baseUrl: string
  /** 源侧配过的模型名。只作展示与可选播种,不参与判定。 */
  models: string[]
  defaultModel?: string
  /** 源侧有本地凭证(env token / apiKey)。★ 仅布尔提示,值不带来。 */
  hasLocalKey: boolean
  diagnostics: ImportDiagnostic[]
}

export interface ImportableProviders {
  kind: ImportSourceKind
  /** 源是否检测到。false 时 providers 必为空。 */
  available: boolean
  /** 已授权的配置目录绝对路径(界面照实显示)。未检测到时是空串。 */
  configDir: string
  providers: ImportableProvider[]
}
