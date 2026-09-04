/**
 * MCP 服务器 —— 「设置 › 连接 › MCP」那一页调的全部频道。
 *
 * 组件不直接碰频道字符串(协议 §9)。这一层薄到只剩转发,但它是唯一的
 * 转发处 —— 频道改名时只有这个文件要动。
 */
import type { McpSecretsInfo, McpServerConfig, McpServerStatus } from '../../../shared/domain/mcp'
import { invoke, tryInvoke } from './ipc'

export function listMcpServers(): Promise<McpServerStatus[]> {
  return invoke('mcp:list', undefined)
}

/** 新增与编辑是同一条 —— 按 id 落库 */
export function upsertMcpServer(config: McpServerConfig): Promise<McpServerStatus> {
  return invoke('mcp:upsert', config)
}

export function removeMcpServer(id: string): Promise<void> {
  return invoke('mcp:remove', { id })
}

/**
 * 「测试连接」按钮。★ 用 `tryInvoke` —— 连不上是这个按钮的**正常结果之一**,
 * 不是异常。抛出来的话调用点得写 try/catch 才能把原因显示出来,
 * 而那个原因(命令找不到 / 401 / 握手超时)恰恰是用户点它的目的。
 */
export function testMcpConnection(id: string): ReturnType<typeof tryInvoke<'mcp:testConnection'>> {
  return tryInvoke('mcp:testConnection', { id })
}

/**
 * 写 env / headers 的值。★ **只写不读**(方案 §9)—— 回程只说存了哪几个键名。
 * `values` 里只放用户这次真填了的那几条:没填的键名意味着「别动已经存着的」。
 */
export function setMcpSecrets(id: string, values: Record<string, string>): Promise<McpSecretsInfo> {
  return invoke('mcp:setSecrets', { id, values })
}

export function getMcpSecretsInfo(id: string): Promise<McpSecretsInfo> {
  return invoke('mcp:getSecretsInfo', { id })
}
