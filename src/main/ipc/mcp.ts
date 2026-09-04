/**
 * MCP 的 handler —— 「库里那张表」和「进程里那些连接」之间的接线员。
 *
 * 分工:配置的增删改查在 `store`(落 SQLite),连接与工具注册在 `McpManager`
 * (`main/mcp/manager.ts`,那一侧完全不认识 electron)。这个文件做三件事,
 * 每一件都必须在这里做、不能推给任何一边:
 *
 * 1. **校验**。id 要过 `MCP_SERVER_ID_RE` —— 它会拼进工具名(`mcp__<id>__<tool>`),
 *    是 §4.4 那条投毒防线上游最靠前的一道。
 * 2. **顺序**。写库 → 起/停连接 → 广播。反过来(先连再写)的话,连上了但没存下,
 *    重启后工具凭空消失;而广播必须排在最后,因为它带的是**写完之后**的状态。
 * 3. **广播**。`windows.emitToAll('mcp:changed')`,和 `settings:changed` 同一种用法:
 *    多窗口下在设置窗加了一台服务器,主窗那边的工具数得跟着变。
 */
import type { McpSecretsInfo, McpServerConfig, McpServerStatus } from '../../shared/domain/mcp'
import {
  MCP_SERVER_ID_RE,
  mcpSecretKind,
  mcpSecretNames,
  mcpSecretRef
} from '../../shared/domain/mcp'
import { getHost, getMcp, setMcpChangeListener } from '../runtime'
import { store } from '../state/store'
import { windows } from '../window/registry'

/** 配置 + 运行时状态,合成一份下发 —— 理由在 `McpServerStatus` 的注释 */
function snapshot(): McpServerStatus[] {
  return getMcp().list(store.listMcpServers())
}

function broadcast(): void {
  windows.emitToAll('mcp:changed', { servers: snapshot() })
}

/**
 * ★ 校验放在这里,不在 `store` 里。
 *
 * 库那一层的职责是「原样存取」,让它去认识工具命名规则,等于把 §4.4 的防线
 * 摊薄到两个文件里;而摊薄的防线最后总有一半没人维护。
 */
function assertValid(cfg: McpServerConfig): void {
  if (!MCP_SERVER_ID_RE.test(cfg.id)) {
    throw new Error(
      `服务器 ID "${cfg.id}" 不合法。只能用字母、数字、下划线和连字符,最多 32 个字符 —— ` +
        `它会成为工具名的一部分(mcp__${cfg.id}__工具名)。`
    )
  }
  if (cfg.name.trim() === '') throw new Error('请给这台服务器起个名字。')
  if (cfg.transport === 'stdio') {
    if (cfg.command.trim() === '') throw new Error('stdio 传输需要填启动命令,例如 npx。')
  } else {
    let url: URL
    try {
      url = new URL(cfg.url)
    } catch {
      throw new Error(`地址 "${cfg.url}" 不是一个合法的 URL,需要完整的 http/https 地址。`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`地址只支持 http / https,收到的是 "${url.protocol}"。`)
    }
  }
}

export function listMcpServers(): McpServerStatus[] {
  return snapshot()
}

/**
 * 新增或修改一台服务器。
 *
 * ★ **改完必须重连,不能沿用旧连接。**命令、地址、密钥任何一处变了,
 * 旧连接背后仍然是改之前那个进程 / 那个 token —— 界面显示「已连接」,
 * 而它连的是用户刚刚改掉的那个东西。所以这里一律先断后连。
 *
 * 停用(`enabled: false`)只断开、不删配置,和参考图上那个开关一致。
 */
export async function upsertMcpServer(cfg: McpServerConfig): Promise<McpServerStatus> {
  assertValid(cfg)
  const saved = store.putMcpServer(cfg)

  await getMcp().disconnect(saved.id)
  const status = saved.enabled ? await getMcp().connect(saved) : getMcp().statusOf(saved)

  broadcast()
  return status
}

/** 删服务器:先断开(工具要从注册表里下掉),再删配置与密钥(一个事务) */
export async function removeMcpServer(id: string): Promise<void> {
  await getMcp().disconnect(id)
  store.removeMcpServer(id)
  broadcast()
}

/**
 * 「测试连接」按钮。就是**真连一次**,不是 ping ——
 * 假连接测不出「命令能跑起来但握手对不上」「token 过期」这两类最常见的失败,
 * 而它们恰好是用户点这个按钮时最想知道的。
 */
export async function testMcpConnection(id: string): Promise<McpServerStatus> {
  const cfg = store.getMcpServer(id)
  if (cfg === undefined) throw new Error(`没有 ID 为 "${id}" 的 MCP 服务器。`)
  const status = await getMcp().connect(cfg)
  broadcast()
  return status
}

/** 库里那张 blob 里真的存着值的键名。解不开(或没存过)一律当空。 */
async function storedNames(cfg: McpServerConfig): Promise<string[]> {
  const declared = mcpSecretNames(cfg)
  if (declared.length === 0) return []
  const raw = await getHost().secrets.get(mcpSecretRef(cfg.id, mcpSecretKind(cfg)))
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return []
    const map = parsed as Record<string, unknown>
    return declared.filter((n) => typeof map[n] === 'string')
  } catch {
    return []
  }
}

export async function getMcpSecretsInfo(id: string): Promise<McpSecretsInfo> {
  const cfg = store.getMcpServer(id)
  const host = getHost()
  if (cfg === undefined) return { storedNames: [], encryptionAvailable: host.secrets.available() }
  return { storedNames: await storedNames(cfg), encryptionAvailable: host.secrets.available() }
}

/**
 * 写密钥。**整张 map 一次写完,不是逐键累加** —— 表单交上来的就是完整的一份,
 * 累加的话用户从表单里删掉一行之后,那个值仍然留在库里并继续生效,
 * 症状是「我明明把那个 token 删了,它却还连得上」。
 *
 * `secrets.set` 在密钥环不可用时会**拒绝**(不是静默明文落盘),异常经
 * `safeHandle` 的信封回到界面;`encryptionAvailable: false` 那条横幅
 * 是给「还没点保存」时的提前告知,两者不重复。
 *
 * 写完要重连:值变了,旧连接背后还是旧 token。
 */
export async function setMcpSecrets(
  id: string,
  values: Record<string, string>
): Promise<McpSecretsInfo> {
  const cfg = store.getMcpServer(id)
  if (cfg === undefined) throw new Error(`没有 ID 为 "${id}" 的 MCP 服务器。`)

  const declared = new Set(mcpSecretNames(cfg))
  // 配置里没声明的键一律丢掉 —— 存下来也永远不会被 `secretValues` 读到,
  // 只会变成一份谁也不知道还在的密文
  const kept = Object.fromEntries(Object.entries(values).filter(([k]) => declared.has(k)))
  await getHost().secrets.set(mcpSecretRef(cfg.id, mcpSecretKind(cfg)), JSON.stringify(kept))

  if (cfg.enabled) {
    await getMcp().disconnect(cfg.id)
    await getMcp().connect(cfg)
  }
  broadcast()
  return getMcpSecretsInfo(id)
}

/**
 * 把广播装进运行时。由 `registerIpc()` 调一次,和 `registerThemeBridge()` 并列。
 *
 * ★ 这条回调是给**不是由 handler 触发的**状态变化用的:后台拉起、
 * 连接中途掉线。handler 自己那几处已经在末尾 `broadcast()` 了 ——
 * 重复播一次是幂等的(载荷是全量快照),漏播才是问题。
 */
export function registerMcpBridge(): void {
  setMcpChangeListener(() => {
    broadcast()
  })
}
