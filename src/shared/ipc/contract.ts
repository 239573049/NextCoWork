/**
 * 类型化 IPC 契约 —— 方案 §3。
 *
 * `docs/ipc-protocol.md` 的三条约定照单全收:三原语语义严格区分、`模块:动作` 冒号命名、
 * 所有 `on*` 必须返回退订函数。四处收紧:
 *
 * | 协议文档 | NextCoWork |
 * |---|---|
 * | §5.2 两种返回风格「模块内保持一致」 | **只用一种** —— IpcResult 信封,全局一致 |
 * | §5.3 靠异常穿过 handle 传播 | **异常绝不穿过 handle** |
 * | §6 长任务无序号、不可重放 | **信封带 seq,可 attach(sinceSeq) 重放** |
 * | §2 每个 API 方法内部硬编码目标频道 | **由契约生成白名单**,preload 运行时校验 |
 */
import type { AgentError } from '../agent/error'
import type { AgentEvent, RunSnapshot } from '../agent/event'
import type { InteractionResponse, PendingInteraction } from '../agent/interaction'
import type { RunRequest } from '../agent/run-request'
import type { ToolInfo } from '../agent/tool'
import type { Bootstrap } from '../domain/bootstrap'
import type { DirListing } from '../domain/file-tree'
import type { McpServerConfig, McpServerStatus } from '../domain/mcp'
import type {
  CredentialInfo,
  FailoverEvent,
  GatewayStatus,
  ModelAlias,
  UpstreamProvider
} from '../domain/provider'
import type { SearchHit, Session, SessionDetail, SessionListItem } from '../domain/session'
import type {
  AppSettings,
  AppSettingsPatch,
  ResolvedTheme,
  StorageStats
} from '../domain/settings'
import type { InnerTabState, WindowKind, WindowTabState } from '../domain/tab'
import type { TerminalBuffer, TerminalCreateRequest, TerminalInfo } from '../domain/terminal'
import type { SkillListItem } from '../domain/skill'
import type { Workspace, WorkspaceSettings } from '../domain/workspace'

// ═══════════════════════════════════════════════════════════════
// 一、信封
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 绝不让异常穿过 ipcMain.handle(方案 §3 规则 3)。
 * Electron 会把它 stringify 成 `Error: Error invoking remote method 'x': ...`,
 * 错误类型全丢 —— 而 §4.11 那套 code 分类正是 UI 用来决定「跳设置页 / 提示 compact /
 * 显示重试倒计时」的唯一依据。
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AgentError }

/**
 * 事件信封。★ seq 放在**信封上**,不放在 event 里(方案 §3 规则 1)。
 * 渲染层防漂移逻辑因此只有一行:seq !== lastSeq + 1 → agent:attach(runId, lastSeq) 补齐。
 * 事后加 seq 要动每个 emit 点、每个 reducer、以及已落盘的格式。
 */
export interface AgentEventEnvelope {
  runId: string
  /** 本批**最后一个**事件的序号;批内事件依次是 seq - events.length + 1 … seq */
  seq: number
  /** 复数:主进程侧 16–33ms 合批(方案 §8) */
  events: AgentEvent[]
}

/**
 * 批内首个事件的序号。信封只带最后一个,这是唯一的反推公式 ——
 * 所以它必须只写一遍。发送端(合批泵)与接收端(session store)对
 * 「seq 指的是哪一个事件」的理解一旦分岔,症状是**每批都报缺口**、
 * 于是每批都触发一次 attach,看起来像网络抖动,实际是一个 ±1。
 */
export function envelopeFirstSeq(env: AgentEventEnvelope): number {
  return env.seq - env.events.length + 1
}

/**
 * 与已应用的 lastSeq 之间是否有缺口 → 走 `agent:attach(runId, lastSeq)` 补齐
 * (方案 §3 规则 1)。
 *
 * 重复的批也会被判为「有缺口」,这是**故意的**:attach 重放是幂等的,
 * 而试图在这里分辨「重复」与「丢失」需要维护一个已见 seq 集合,不值当。
 */
export function hasSeqGap(env: AgentEventEnvelope, lastSeq: number): boolean {
  return envelopeFirstSeq(env) !== lastSeq + 1
}

// ═══════════════════════════════════════════════════════════════
// 二、渲染 → 主,要返回值(invoke)
// ═══════════════════════════════════════════════════════════════

export interface IpcInvokeMap {
  // ── 应用 ──
  'app:getBootstrap': { req: void; res: Bootstrap }
  'app:openExternal': { req: { url: string }; res: void }

  // ── 设置 ──
  'settings:get': { req: void; res: AppSettings }
  // 嵌套块可以只给要改的属性 —— 见 AppSettingsPatch 的注释(那是一整类竞态)
  'settings:update': { req: AppSettingsPatch; res: AppSettings }

  // ── 工作区 ──
  'workspace:list': { req: void; res: Workspace[] }
  /** ★ 走主进程 dialog.showOpenDialog —— 渲染层永不指定任意路径(方案 §9) */
  'workspace:pick': { req: void; res: Workspace | null }
  'workspace:update': {
    req: { id: string; name?: string; settings?: Partial<WorkspaceSettings> }
    res: Workspace
  }
  /** 关闭 = 从列表移除这条记录,与「关闭外层 Tab」是两回事(方案 §8) */
  'workspace:close': { req: { id: string }; res: void }
  /**
   * 右侧文件树列一层。**懒加载**:展开一个目录才拉它,不递归 ——
   * 一次把 `node_modules` 整棵树拉回来,IPC 那一下就够卡半秒。
   *
   * `path` 是**工作区相对**路径且经 `resolveInWorkspace` 校验(方案 §9):
   * 它来自渲染层,是不可信输入,`../..` 会被拒。
   */
  'workspace:listDir': { req: { workspaceId: string; path: string }; res: DirListing }

  // ── Tab 状态(读;写走 send,见 IpcSendMap) ──
  'tabs:getInner': { req: { workspaceId: string }; res: InnerTabState }

  // ── 会话 ──
  'sessions:list': { req: { workspaceId: string; archived?: boolean }; res: SessionListItem[] }
  'sessions:get': { req: { sessionId: string }; res: SessionDetail }
  'sessions:create': { req: { workspaceId: string; title?: string }; res: Session }
  'sessions:rename': { req: { sessionId: string; title: string }; res: void }
  'sessions:setArchived': { req: { sessionId: string; archived: boolean }; res: void }
  'sessions:setFavorited': { req: { sessionId: string; favorited: boolean }; res: void }
  'sessions:delete': { req: { sessionId: string }; res: void }
  /** 全局入口,但结果可按工作区筛(同「定时任务」页那个筛选器) */
  'conversations:searchAll': {
    req: { q: string; workspaceId?: string; limit: number }
    res: SearchHit[]
  }

  // ── Agent ──
  /** ★ runId 由调用方传入,不由这里返回(方案 §3 规则 2) */
  'agent:run': { req: RunRequest; res: void }
  'agent:attach': { req: { runId: string; sinceSeq: number }; res: RunSnapshot }
  'agent:abort': { req: { runId: string; cascade: boolean }; res: void }
  /** ★ 审批 / 反问 / 计划确认三种 kind 共用这一个(方案 §4.6) */
  'agent:respondInteraction': { req: InteractionResponse; res: void }
  'agent:listInteractions': { req: { runId?: string }; res: PendingInteraction[] }
  'agent:listTools': { req: { workspaceId: string }; res: ToolInfo[] }

  // ── 终端 ──
  'terminal:create': { req: TerminalCreateRequest; res: TerminalInfo }
  'terminal:kill': { req: { id: string }; res: void }
  'terminal:list': { req: { workspaceId: string }; res: TerminalInfo[] }
  'terminal:getBuffer': { req: { id: string }; res: TerminalBuffer }

  // ── MCP ──
  'mcp:list': { req: void; res: McpServerStatus[] }
  'mcp:upsert': { req: McpServerConfig; res: McpServerStatus }
  'mcp:remove': { req: { id: string }; res: void }
  'mcp:testConnection': { req: { id: string }; res: McpServerStatus }

  // ── Skill ──
  'skills:list': { req: { workspaceId?: string }; res: SkillListItem[] }
  'skills:setGlobalEnabled': { req: { skillId: string; enabled: boolean }; res: void }
  'skills:setWorkspaceActive': {
    req: { skillId: string; workspaceId: string; active: boolean }
    res: void
  }

  // ── 供应商 / 模型别名 ──
  'provider:list': { req: void; res: UpstreamProvider[] }
  'provider:upsert': { req: UpstreamProvider; res: UpstreamProvider }
  'provider:remove': { req: { id: string }; res: void }
  /** ★ 只写不读:返回 { hasKey, last4 },永不回传明文(方案 §9) */
  'provider:setCredential': { req: { providerId: string; apiKey: string }; res: CredentialInfo }
  'provider:getCredentialInfo': { req: { providerId: string }; res: CredentialInfo }
  'provider:listModels': { req: { providerId?: string }; res: ModelAlias[] }
  'provider:test': { req: { providerId: string }; res: { ok: boolean; latencyMs?: number } }

  // ── 本地网关 ──
  'gateway:getStatus': { req: void; res: GatewayStatus }
  'gateway:setEnabled': { req: { enabled: boolean }; res: GatewayStatus }
  'gateway:resetHealth': { req: { providerId?: string }; res: GatewayStatus }

  // ── 数据(界面「数据」页) ──
  'storage:getStats': { req: void; res: StorageStats }
  'storage:vacuum': { req: void; res: StorageStats }
}

// ═══════════════════════════════════════════════════════════════
// 三、渲染 → 主,高频无返回(send)—— 协议 §3.2
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 这张表存在的理由就是终端(方案 §6):每次按键做一次请求/响应往返,
 * 在快速输入下会肉眼可见地卡。
 */
export interface IpcSendMap {
  'terminal:write': { id: string; data: string }
  'terminal:resize': { id: string; cols: number; rows: number }

  /** 握手第一步(协议 §7):window:ready → app:getBootstrap → 首屏 → 增量事件 */
  'window:ready': { kind: WindowKind }

  /**
   * Tab 布局持久化。★ 用 send 不用 invoke:拖动排序时每帧都在变,
   * 而渲染层不需要任何返回值。主进程侧防抖 500ms 再落 kv 表(方案 §9)。
   */
  'tabs:persistOuter': { kind: WindowKind; state: WindowTabState }
  'tabs:persistInner': { workspaceId: string; state: InnerTabState }
}

// ═══════════════════════════════════════════════════════════════
// 四、主 → 渲染,定向推送(协议 §7)
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 事件按订阅定向推送,**绝不广播**(方案 §3 规则 5)。
 * WindowRegistry 维护 runId → Set<webContents>;⌥Space 快捷窗不该收到主窗的 token 流。
 * 每次 send 前判 webContents.isDestroyed()。
 */
export interface IpcEventMap {
  'agent:event': AgentEventEnvelope
  'terminal:data': { id: string; chunk: string }
  'terminal:exit': { id: string; code: number }
  'gateway:status': GatewayStatus
  'gateway:failover': FailoverEvent
  'settings:changed': AppSettings
  'theme:changed': { resolved: ResolvedTheme }
  'workspace:changed': { workspaces: Workspace[] }
  'skills:changed': void
  'mcp:changed': { servers: McpServerStatus[] }
}

// ═══════════════════════════════════════════════════════════════
// 五、频道白名单 —— preload 的运行时防线
// ═══════════════════════════════════════════════════════════════

/**
 * ★ Preload 是安全边界,必须在**运行时**校验频道(方案 §3 规则 6)。
 * 仅有编译期类型不够 —— 被攻破的渲染层可以 `invoke(任意字符串)`,
 * 而在本架构里那等价于经工具层获得任意文件系统访问。
 *
 * 下面三个 const 的 `satisfies Record<keyof XxxMap, 1>` 是**双向**约束:
 * - 少写一个 → Record 缺 key,编译报错
 * - 多写一个 → 对象字面量多余属性检查,编译报错
 *
 * 所以「由契约生成白名单」在这里是可执行的保证,而不是一句口号 ——
 * 往 map 里加频道却忘了加白名单,`npm run typecheck` 当场拦下。
 */
export const INVOKE_CHANNELS = {
  'app:getBootstrap': 1,
  'app:openExternal': 1,
  'settings:get': 1,
  'settings:update': 1,
  'workspace:list': 1,
  'workspace:pick': 1,
  'workspace:update': 1,
  'workspace:close': 1,
  'workspace:listDir': 1,
  'tabs:getInner': 1,
  'sessions:list': 1,
  'sessions:get': 1,
  'sessions:create': 1,
  'sessions:rename': 1,
  'sessions:setArchived': 1,
  'sessions:setFavorited': 1,
  'sessions:delete': 1,
  'conversations:searchAll': 1,
  'agent:run': 1,
  'agent:attach': 1,
  'agent:abort': 1,
  'agent:respondInteraction': 1,
  'agent:listInteractions': 1,
  'agent:listTools': 1,
  'terminal:create': 1,
  'terminal:kill': 1,
  'terminal:list': 1,
  'terminal:getBuffer': 1,
  'mcp:list': 1,
  'mcp:upsert': 1,
  'mcp:remove': 1,
  'mcp:testConnection': 1,
  'skills:list': 1,
  'skills:setGlobalEnabled': 1,
  'skills:setWorkspaceActive': 1,
  'provider:list': 1,
  'provider:upsert': 1,
  'provider:remove': 1,
  'provider:setCredential': 1,
  'provider:getCredentialInfo': 1,
  'provider:listModels': 1,
  'provider:test': 1,
  'gateway:getStatus': 1,
  'gateway:setEnabled': 1,
  'gateway:resetHealth': 1,
  'storage:getStats': 1,
  'storage:vacuum': 1
} as const satisfies Record<keyof IpcInvokeMap, 1>

export const SEND_CHANNELS = {
  'terminal:write': 1,
  'terminal:resize': 1,
  'window:ready': 1,
  'tabs:persistOuter': 1,
  'tabs:persistInner': 1
} as const satisfies Record<keyof IpcSendMap, 1>

export const EVENT_CHANNELS = {
  'agent:event': 1,
  'terminal:data': 1,
  'terminal:exit': 1,
  'gateway:status': 1,
  'gateway:failover': 1,
  'settings:changed': 1,
  'theme:changed': 1,
  'workspace:changed': 1,
  'skills:changed': 1,
  'mcp:changed': 1
} as const satisfies Record<keyof IpcEventMap, 1>

// ═══════════════════════════════════════════════════════════════
// 六、派生工具类型
// ═══════════════════════════════════════════════════════════════

export type InvokeChannel = keyof IpcInvokeMap
export type SendChannel = keyof IpcSendMap
export type EventChannel = keyof IpcEventMap

export type InvokeReq<K extends InvokeChannel> = IpcInvokeMap[K]['req']
export type InvokeRes<K extends InvokeChannel> = IpcInvokeMap[K]['res']

/** on() 必须返回退订函数(协议 §3.3 的硬约定,方案 §3 规则 4) */
export type Unsubscribe = () => void

export function isInvokeChannel(ch: string): ch is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(INVOKE_CHANNELS, ch)
}

export function isSendChannel(ch: string): ch is SendChannel {
  return Object.prototype.hasOwnProperty.call(SEND_CHANNELS, ch)
}

export function isEventChannel(ch: string): ch is EventChannel {
  return Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, ch)
}
