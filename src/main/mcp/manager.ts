/**
 * `McpManager` —— 一台 MCP 服务器的连接生命周期,以及它带来的工具在
 * `ToolRegistry` 里的进出。方案 §7 / 步骤 10。
 *
 * ## 这个文件不 import electron,也不 import store
 *
 * 状态变化经**注入的 `onChange` 回调**上报,广播由 `ipc/mcp.ts` 做;配置由调用方喂进来。
 * 不是为了纯粹,是为了 `__tests__/manager.test.ts` 能用 SDK 自带的 `InMemoryTransport`
 * 真起一台服务器跑完整条路 —— 「工具注册进去了没有」这件事,
 * 除了真跑一遍以外没有别的验证方式。
 *
 * ## 三条不变式
 *
 * 1. **下线先于关闭。** `disconnect` 里 `unregisterBySource()` 排在 `client.close()`
 *    前面。反过来的话,在 close 与 unregister 之间的那个窗口里,注册表还挂着
 *    一批指向已死连接的工具 —— 模型这一轮正好调到就是一个说不清的超时。
 *    (正在执行的那次调用不受影响:执行方早就持有 `Tool` 对象的引用,
 *    见 `registry.ts` 的 `unregisterBySource` 注释。)
 * 2. **重连是替换,不是报错。** `register` 对同一个 internalId 是替换,
 *    且 externalName 由 internalId 记忆 —— 所以重连之后历史转录里的工具名仍然对得上。
 * 3. **同一个 id 的连接同时只有一次在跑。** 设置页那个「测试连接」按钮双击是常态,
 *    两条连接同时起来的话,后一条注册完工具,前一条的 `disconnect` 会把它们全下掉。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpConnectionState, McpServerConfig, McpServerStatus } from '../../shared/domain/mcp'
import { MCP_SERVER_ID_RE, mcpSecretKind, mcpSecretNames, mcpSecretRef } from '../../shared/domain/mcp'
import type { KernelHost } from '../kernel/host'
import type { ToolRegistry } from '../kernel/tool/registry'
import type { McpToolDescriptor } from './bridge'
import { isRejected, toRegistration } from './bridge'
import { EnvironmentError } from '../../shared/domain/environment'

/** 连接 + 初始化握手的墙钟预算。卡住的服务器不该让设置页一直转圈。 */
const CONNECT_TIMEOUT_MS = 30_000
/** `listTools` 的预算。握手过了但列不出工具,也是一次失败。 */
const LIST_TOOLS_TIMEOUT_MS = 15_000

export interface McpManagerDeps {
  tools: ToolRegistry
  /** 只要 `secrets` 与 `logger` 两项 —— 这个类不需要也不该拿到整个 host */
  secrets: KernelHost['secrets']
  logger: KernelHost['logger']
  assertReady?: () => void
  /** 状态一变就叫一次。广播由调用方做(这个文件不认识 BrowserWindow) */
  onChange?: (id: string) => void
  /**
   * 「怎么够到这台服务器」这个端口。**生产路径不传**,走下面 `makeTransport`
   * 那三个真传输。
   *
   * 留这个口子是为了测试能用 SDK 自带的 `InMemoryTransport` 起一台**真服务器**
   * 跑完整条路 —— 「工具真的注册进 ToolRegistry 了没有、调用真的能往返吗」
   * 这件事,除了真跑一遍以外没有别的验证方式,而 stdio 需要一个子进程、
   * http 需要一个监听端口,两者都会把单测变成集成测试。
   */
  transportFactory?: (cfg: McpServerConfig, values: Record<string, string>) => Promise<Transport>
}

interface Entry {
  /** `connecting` 与 `error` 两态下没有 client —— 所以是可选的,不是一个假对象 */
  client?: Client
  transport?: Transport
  state: McpConnectionState
  tools: string[]
  error?: string
  connectedAt?: number
}

/** 客户端自报家门。服务器日志里看到的就是这个名字。 */
const CLIENT_INFO = { name: 'NextCoWork', version: '0.1.0' } as const

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`${what}超时(超过 ${String(ms / 1000)} 秒)`))
      }, ms)
      timer = t
      // 正常路径下别让这个定时器把进程按住不退
      if (typeof t.unref === 'function') t.unref()
    })
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  /*
    ENOENT 是 stdio 服务器最常见的失败,而 Node 的原文
    (`spawn npx ENOENT`)对着设置页的用户说不通。翻成一句能照着做的话。
  */
  if (msg.includes('ENOENT')) {
    return `${msg} —— 找不到这个命令。请确认它已经安装,并且在 PATH 里(打包后的应用继承的是登录 shell 的 PATH,不是终端里的)。`
  }
  return msg
}

export class McpManager {
  private readonly entries = new Map<string, Entry>()
  /** 见文件头不变式 3:同 id 的连接串行化 */
  private readonly inflight = new Map<string, Promise<McpServerStatus>>()

  constructor(private readonly deps: McpManagerDeps) {}

  /**
   * 取密钥。**整张 map 加密成一个 blob**(见 `mcpSecretRef` 的注释),
   * 这里解开之后**只取配置里声明过的键** —— 库里那张 map 可能残留着
   * 用户上一次填过、后来从表单里删掉的键名,配置才是权威。
   */
  private async secretValues(cfg: McpServerConfig): Promise<Record<string, string>> {
    const names = mcpSecretNames(cfg)
    if (names.length === 0) return {}
    const raw = await this.deps.secrets.get(mcpSecretRef(cfg.id, mcpSecretKind(cfg)))
    if (raw === null) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.deps.logger.warn(`[mcp] ${cfg.id} 的密钥不是合法 JSON,已当作没有配置`)
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null) return {}
    const map = parsed as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const n of names) {
      const v = map[n]
      if (typeof v === 'string') out[n] = v
    }
    return out
  }

  private async makeTransport(cfg: McpServerConfig): Promise<Transport> {
    const values = await this.secretValues(cfg)
    if (this.deps.transportFactory !== undefined) return this.deps.transportFactory(cfg, values)
    if (cfg.transport === 'stdio') {
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        /*
          ★ `getDefaultEnvironment()` 打底,而不是 `process.env`。
          它只放行 HOME / PATH / SHELL / TERM / USER 那几个,于是主进程里那些
          Electron 自己的变量(`ELECTRON_RUN_AS_NODE` 是最要命的一个 ——
          它会让子进程里的 electron 变成一个无窗口的 node)不会漏给服务器。
          用户配的键名覆盖在上面。
        */
        env: { ...getDefaultEnvironment(), ...values },
        // 服务器的 stderr 不该混进应用自己的 stdout —— 那是诊断信息,不是我们的日志
        stderr: 'pipe'
      })
    }
    const url = new URL(cfg.url)
    const headers = values
    return cfg.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  }

  /**
   * 连上、列工具、逐个注册。**任何一步失败都收敛成 `state: 'error'` 的状态,
   * 不抛出去** —— 调用方是 IPC handler 和启动流程,它们要的是「这台怎么了」,
   * 不是一个异常。抛的话启动时一台服务器连不上就能把 `initRuntime` 打断。
   */
  async connect(cfg: McpServerConfig): Promise<McpServerStatus> {
    const running = this.inflight.get(cfg.id)
    if (running !== undefined) return running

    const task = this.doConnect(cfg).finally(() => {
      this.inflight.delete(cfg.id)
    })
    this.inflight.set(cfg.id, task)
    return task
  }

  private async doConnect(cfg: McpServerConfig): Promise<McpServerStatus> {
    if (!MCP_SERVER_ID_RE.test(cfg.id)) {
      return this.fail(cfg, `服务器 id "${cfg.id}" 不合法(只接受字母、数字、下划线、连字符,最长 32)`)
    }

    // 重连:先把上一条彻底收干净。不收的话工具会重复注册在两个 client 上
    await this.disconnect(cfg.id)

    const entry: Entry = { state: 'connecting', tools: [] }
    this.entries.set(cfg.id, entry)
    this.deps.onChange?.(cfg.id)

    let client: Client
    let transport: Transport
    try {
      this.deps.assertReady?.()
      transport = await this.makeTransport(cfg)
      if (this.entries.get(cfg.id) !== entry) { await transport.close(); return this.statusOf(cfg) }
      client = new Client(CLIENT_INFO)
      entry.client = client
      entry.transport = transport
      client.onclose = () => {
        if (this.entries.get(cfg.id) !== entry) return
        this.deps.tools.unregisterBySource({ kind: 'mcp', serverId: cfg.id })
        entry.state = 'disconnected'
        entry.tools = []
        this.deps.onChange?.(cfg.id)
      }
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '连接')
    } catch (err) {
      await entry.transport?.close().catch(() => {})
      if (this.entries.get(cfg.id) !== entry) return this.statusOf(cfg)
      return this.fail(cfg, describeError(err))
    }

    let descriptors: McpToolDescriptor[]
    try {
      const res = await withTimeout(client.listTools(), LIST_TOOLS_TIMEOUT_MS, '获取工具列表')
      descriptors = res.tools
      this.deps.assertReady?.()
      if (this.entries.get(cfg.id) !== entry || entry.state !== 'connecting') { await client.close(); return this.statusOf(cfg) }
    } catch (err) {
      // 握手过了但列不出工具 —— 连接留不得,不然它会一直挂着占着子进程
      await client.close().catch(() => {})
      if (this.entries.get(cfg.id) !== entry) return this.statusOf(cfg)
      return this.fail(cfg, describeError(err))
    }

    const registered: string[] = []
    const rejected: string[] = []
    for (const d of descriptors) {
      const reg = toRegistration(cfg, d, client)
      if (isRejected(reg)) {
        rejected.push(`${reg.name}(${reg.reason})`)
        continue
      }
      registered.push(this.deps.tools.register({ ...reg, execute: async (input, context) => {
        this.deps.assertReady?.()
        if (this.entries.get(cfg.id) !== entry || entry.state !== 'connected'
          || (cfg.workspaceId !== undefined && context.workspaceId !== cfg.workspaceId)) throw new EnvironmentError('disconnected')
        return reg.execute(input, context)
      } }).externalName)
    }
    if (rejected.length > 0) {
      this.deps.logger.warn(`[mcp] ${cfg.id} 有 ${String(rejected.length)} 个工具被拒绝:${rejected.join('、')}`)
    }

    Object.assign(entry, {
      client,
      transport,
      state: 'connected',
      tools: registered,
      /*
        拒绝的工具**写进 error 字段照实显示**,即使这次连接是成功的。
        不写的话用户看到的是「已连接 · 3 个工具」,而服务器文档上写着 5 个 ——
        差在哪里没有任何地方说得出来。
      */
      error:
        rejected.length === 0
          ? undefined
          : `有 ${String(rejected.length)} 个工具没有接入:${rejected.join('、')}`,
      connectedAt: Date.now()
    } satisfies Entry)
    this.deps.onChange?.(cfg.id)
    return this.statusOf(cfg)
  }

  private fail(cfg: McpServerConfig, error: string): McpServerStatus {
    this.entries.set(cfg.id, { state: 'error', tools: [], error })
    this.deps.logger.warn(`[mcp] ${cfg.id} 连接失败:${error}`)
    this.deps.onChange?.(cfg.id)
    return this.statusOf(cfg)
  }

  /**
   * 下线并断开。**顺序有意义**,见文件头不变式 1。
   *
   * 没连过的 id 是**正常入参**(启动时逐台连之前会先清一遍),不是错误。
   */
  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    // 即使 entry 不在(连接失败过、或从没连过),注册表里也可能留着上一轮的工具
    this.deps.tools.unregisterBySource({ kind: 'mcp', serverId: id })
    if (entry?.client !== undefined) {
      // close 失败不该阻塞调用方 —— 工具已经下线了,进程回收交给操作系统
      await entry.client.close().catch((err: unknown) => {
        this.deps.logger.warn(`[mcp] ${id} 关闭时出错(工具已下线,忽略):${String(err)}`)
      })
    } else await entry?.transport?.close().catch(() => {})
    this.deps.onChange?.(id)
  }

  /** 配置 + 运行时状态,合成列表页要的那一行(见 `McpServerStatus` 的注释) */
  statusOf(cfg: McpServerConfig): McpServerStatus {
    const e = this.entries.get(cfg.id)
    if (e === undefined) {
      return { config: cfg, state: 'disconnected', tools: [], toolCount: 0 }
    }
    return {
      config: cfg,
      state: e.state,
      tools: e.tools,
      toolCount: e.tools.length,
      error: e.error,
      connectedAt: e.connectedAt
    }
  }

  list(configs: readonly McpServerConfig[]): McpServerStatus[] {
    return configs.map((c) => this.statusOf(c))
  }

  /**
   * 启动时把已启用的服务器拉起来。**并行,且一台都不阻塞调用方** ——
   * `initRuntime` 是首屏路径上的,一台连不上的服务器不该让窗口晚 30 秒出现。
   */
  connectEnabledInBackground(configs: readonly McpServerConfig[]): void {
    for (const cfg of configs) {
      if (!cfg.enabled || cfg.workspaceId !== undefined) continue
      void this.connect(cfg)
    }
  }

  /** 退出时全部收掉,让 stdio 的子进程跟着走 */
  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.disconnect(id)))
  }
}
