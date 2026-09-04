/**
 * MCP —— 方案 §7。连上后经**同一个 ToolRegistry.register** 注册,
 * 前缀 `mcp__<serverId>__<tool>`。
 *
 * ★ **配置里没有一个明文密钥。** stdio 的环境变量、HTTP/SSE 的请求头,
 * 十有八九装的是 token(`Authorization: Bearer …` 是 MCP 远程服务器的标准做法)。
 * 所以这里只存**键名数组**,值整张表加密后落在 `credentials` 表的
 * `mcpSecretRef(id, …)` 下 —— 和上游供应商的 apiKey 走同一套 safeStorage,
 * 理由也同一条:`db/schema.ts` 那张表只认字节。
 *
 * 这带来一个必须知道的后果:**配置能导出,密钥不能**。换机器要重填,
 * 这是 safeStorage 绑定当前用户密钥环的直接结果,不是遗漏。
 */

export type McpTransport = 'stdio' | 'sse' | 'streamable-http'

interface McpServerBase {
  id: string
  name: string
  /** 参考图那栏「描述(可选)」。也会拼进工具描述前缀,给模型一点上下文 */
  description?: string
  enabled: boolean
}

export type McpServerConfig =
  | (McpServerBase & {
      transport: 'stdio'
      command: string
      args: string[]
      /** ★ 只有键名。值在 safeStorage 里,见文件头 */
      envNames: string[]
      /** 留空 = 用工作区根目录 */
      cwd?: string
    })
  | (McpServerBase & {
      transport: 'sse' | 'streamable-http'
      url: string
      /** ★ 只有键名。值在 safeStorage 里,见文件头 */
      headerNames: string[]
    })

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * 列表行要显示的一切 = 配置 + 运行时状态。
 *
 * 合成一个而不是让渲染层拿两份自己 join:两份会各自到达,中间那一帧
 * 必然有一边是旧的 —— 表现是「刚加的服务器显示成未连接,一秒后才跳成已连接」,
 * 而实际上它从来没有断过。
 */
export interface McpServerStatus {
  config: McpServerConfig
  state: McpConnectionState
  /** 已注册工具的 externalName。设置页要展开列出来 */
  tools: string[]
  toolCount: number
  error?: string
  connectedAt?: number
}

/** serverId 会进工具名,必须先过一道白名单(§4.4 的投毒防线)。 */
export const MCP_SERVER_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/
export const MCP_PREFIX = 'mcp__'

export function mcpInternalId(serverId: string, toolName: string): string {
  return `${MCP_PREFIX}${serverId}__${toolName}`
}

/**
 * 密钥在 `credentials` 表里的 ref。**整张 map 加密成一个 JSON blob**,
 * 不是一个键一行 —— 一个键一行的话删服务器要先把键名读出来才知道删哪些行,
 * 而键名恰好存在正在被删的那条配置里。
 */
export function mcpSecretRef(serverId: string, kind: 'env' | 'headers'): string {
  return `mcp:${serverId}:${kind}`
}

/** 配置里声明的密钥键名 —— 删服务器时要按这个清理 safeStorage */
export function mcpSecretKind(cfg: McpServerConfig): 'env' | 'headers' {
  return cfg.transport === 'stdio' ? 'env' : 'headers'
}

export function mcpSecretNames(cfg: McpServerConfig): readonly string[] {
  return cfg.transport === 'stdio' ? cfg.envNames : cfg.headerNames
}

/**
 * 「这台服务器的密钥现在存了哪几个键」——`mcp:setSecrets` / `mcp:getSecretsInfo` 的回程。
 *
 * ★ 回的是**键名**,不是值。键名本来就明文躺在 `mcp_servers.json` 的
 * `envNames` / `headerNames` 里,回传它不泄露任何东西;而值是那条
 * 「凭证频道只写不读」规矩管着的东西(方案 §9),永远不回程。
 *
 * 为什么不复用 `CredentialInfo`:那个形状是给**单个** apiKey 设计的
 * (`last4` 取末四位)。MCP 这边是一张 map,「末四位」对一张 map 没有意义 ——
 * 硬套的话界面上会出现一个来自随机某个键的四位数字,比不显示更糟。
 */
export interface McpSecretsInfo {
  /** 库里真的存着值的键名,是 `mcpSecretNames(cfg)` 的子集 */
  storedNames: string[]
  /** Linux 无 keyring 时为 false —— 界面要照实横幅,而不是假装存上了 */
  encryptionAvailable: boolean
}
