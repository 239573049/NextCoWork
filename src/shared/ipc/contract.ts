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
import type { McpSecretsInfo, McpServerConfig, McpServerStatus } from '../domain/mcp'
import type { ProxyPasswordInfo } from '../domain/proxy'
import type {
  Attachment,
  AttachmentScope,
  AttachmentUploadRequest
} from '../domain/attachment'
import type { SessionInputState } from '../domain/queued-input'
import type { SearchProviderId, SearchProviderStatus } from '../domain/search'
import type {
  CredentialInfo,
  FailoverEvent,
  FetchedModel,
  GatewayStatus,
  ModelAlias,
  UpstreamProvider
} from '../domain/provider'
import type { ModelCatalogDefinition } from '../domain/model-catalog'
import type { SearchHit, Session, SessionDetail, SessionListItem } from '../domain/session'
import type { AppSettings, AppSettingsPatch, ResolvedTheme, StorageStats } from '../domain/settings'
import type { InnerTabState, WindowKind, WindowTabState } from '../domain/tab'
import type { ImageTheme } from '../domain/theme'
import type { TerminalBuffer, TerminalCreateRequest, TerminalInfo } from '../domain/terminal'
import type { SkillListItem } from '../domain/skill'
import type { Workspace, WorkspaceSettings } from '../domain/workspace'
import type { BrowserChange, BrowserProfile, BrowserTab } from '../domain/browser'
import type {
  BackupStatus,
  CleanupAge,
  CleanupPreview,
  CleanupResult,
  ImportApplyResult,
  ImportPreview,
  RestoreResult
} from '../domain/data'

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

/**
 * `theme:importImage` 的回程:主进程已经把文件收进 `userData/themes/`,
 * 但**还没登记** —— 种子色和色点要等渲染层解码完这张位图才算得出来
 * (`extractPalette` 要的是 RGBA,而主进程没有 canvas)。
 *
 * 所以导入是**两相**的:这一相给字节,渲染层算完再走 `theme:saveImage` 落表。
 * 中途放弃(窗口关了、这张图解不开)留下的是一个没进表的孤儿文件,下次启动扫掉 ——
 * 而不是一条读得出文件、读不出颜色的坏记录。**宁可丢文件,不要留坏行。**
 */
export interface ImportedImage {
  id: string
  /** 文件名去掉扩展名,当作这张卡的默认名字 */
  name: string
  mime: string
  /**
   * ★ **`<ArrayBuffer>` 不是装饰。** TS 5.7 起 `Uint8Array` 对底层缓冲泛型化,
   * 而裸 `Uint8Array` 推出来的是 `ArrayBufferLike` —— 里面含着 `SharedArrayBuffer`,
   * 于是 `new Blob([bytes])` 不给过(`BlobPart` 只收 `ArrayBufferView<ArrayBuffer>`)。
   * 而渲染层拿到这些字节**唯一要做的事**就是建 Blob 去解码。
   *
   * 写死成 `<ArrayBuffer>` 是**如实描述**,不是糊弄编译器:主进程那边是
   * `new Uint8Array(readFileSync(...))`,结构化克隆过来的也从不是共享内存。
   * 换成在调用点 `new Uint8Array(bytes)` 复制一份,代价是白拷一次最大 16MB。
   */
  bytes: Uint8Array<ArrayBuffer>
}

// ═══════════════════════════════════════════════════════════════
// 二、渲染 → 主,要返回值(invoke)
// ═══════════════════════════════════════════════════════════════

export interface IpcInvokeMap {
  // ── 应用 ──
  'app:getBootstrap': { req: void; res: Bootstrap }
  'app:openExternal': { req: { url: string }; res: void }
  'app:copyText': { req: { text: string }; res: void }
  'app:openSessionWindow': { req: { workspaceId: string; sessionId: string }; res: void }

  // ── 设置 ──
  'settings:get': { req: void; res: AppSettings }
  // 嵌套块可以只给要改的属性 —— 见 AppSettingsPatch 的注释(那是一整类竞态)
  'settings:update': { req: AppSettingsPatch; res: AppSettings }

  // ── 图片主题(设置 › 偏好 › 图片主题)──
  /** ★ 选文件走主进程 dialog.showOpenDialog —— 渲染层永不指定任意路径(方案 §9) */
  'theme:importImage': { req: void; res: ImportedImage | null }
  /**
   * 导入第二相:渲染层解码算出 seed/palette 之后才登记。返回登记后的全表 ——
   * 让调用点不必再补一次 `theme:listImages`(两次调用之间的那一小段里,
   * 界面上的列表和磁盘上的表是两回事)。
   */
  'theme:saveImage': {
    req: { id: string; name: string; seed: string; palette: string[] }
    res: ImageTheme[]
  }
  'theme:listImages': { req: void; res: ImageTheme[] }
  /**
   * ★ **id → 查表 → 路径。** 渲染层递进来的 id 只用来查一条记录,
   * 拿到的是主进程当初自己写下的路径;id 本身**从不参与 `join`**(方案 §9)。
   */
  'theme:readImage': {
    req: { id: string }
    res: { mime: string; bytes: Uint8Array<ArrayBuffer> }
  }
  'theme:deleteImage': { req: { id: string }; res: ImageTheme[] }

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

  // ── 浏览器工作台 ──
  'browser:list': { req: { workspaceId: string }; res: BrowserTab[] }
  'browser:open': {
    req: { workspaceId: string; url: string; title?: string; profileId?: string }
    res: BrowserTab
  }
  'browser:navigate': { req: { workspaceId: string; tabId: string; url: string }; res: BrowserTab }
  'browser:close': { req: { workspaceId: string; tabId: string }; res: void }
  'browser:profiles': { req: void; res: BrowserProfile[] }
  'browser:createProfile': { req: { name: string; domains?: string[]; startUrl?: string }; res: BrowserProfile }
  'browser:deleteProfile': { req: { id: string }; res: void }
  'browser:exportCookies': { req: { workspaceId: string; profileId: string }; res: boolean }
  'browser:importCookies': { req: { workspaceId: string; profileId: string }; res: number | null }
  'browser:clearProfileState': { req: { workspaceId: string; profileId: string }; res: void }

  // ── Tab 状态(读;写走 send,见 IpcSendMap) ──
  'tabs:getInner': { req: { workspaceId: string }; res: InnerTabState }

  /**
   * 未发出的输入(草稿 + 插入队列)。★ **读走 invoke,写走 send** ——
   * 与 Tab 布局同构。返回 null = 没有存档 / 存档已失效(版本不符或超 TTL),
   * 校验在主进程侧做,渲染层拿到的要么是可用的,要么是 null。
   */
  'session:getInput': { req: { sessionId: string }; res: SessionInputState | null }

  // ── 附件(上传走 invoke;读取走 ncw:// 协议,不经 IPC) ──
  /**
   * ★ 上传必须知道成败与落点,所以是 invoke 而不是 send。
   * 返回的 `Attachment.url` 是 `ncw://` 地址 —— **绝对路径不出主进程**。
   */
  'attachment:upload': { req: AttachmentUploadRequest; res: Attachment }
  /** ★ 走主进程 dialog,渲染层永不指定任意路径(方案 §9)。取消返回空数组 */
  'attachment:pick': {
    req: { scope: AttachmentScope; ownerId?: string }
    res: Attachment[]
  }
  'attachment:remove': { req: { id: string }; res: void }
  /** 已上传但还没发出去的 —— 重启后恢复草稿附件区 */
  'attachment:listBySession': { req: { sessionId: string }; res: Attachment[] }

  // ── 会话 ──
  'sessions:list': { req: { workspaceId: string; archived?: boolean }; res: SessionListItem[] }
  'sessions:get': { req: { sessionId: string }; res: SessionDetail }
  'sessions:create': { req: { workspaceId: string; title?: string; sessionId?: string }; res: Session }
  'sessions:duplicate': { req: { sessionId: string; title: string }; res: Session }
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
  /**
   * stdio 的环境变量值 / HTTP 的请求头值。**只写不读**,和 `provider:setCredential`
   * 同一条规矩 —— 回程只说存了哪几个键名(见 `McpSecretsInfo`)。
   *
   * 和 `mcp:upsert` 分开两条频道,而不是把值塞进 `McpServerConfig`:
   * 那个类型会被写进 `mcp_servers.json` 那一列,也会被将来的「导出配置」读到。
   * 值一旦进了这个类型,总有一天会跟着配置一起落到明文里。
   */
  'mcp:setSecrets': { req: { id: string; values: Record<string, string> }; res: McpSecretsInfo }
  'mcp:getSecretsInfo': { req: { id: string }; res: McpSecretsInfo }

  // ── 搜索服务(设置 › 连接 › 搜索服务)──
  /*
    ★ 叫 `websearch:*` 而不是 `search:*`。本仓库已经有一个「搜索」了 ——
    `conversations:searchAll` 那个本地全文检索。两个 `search:` 前缀混在同一张表里,
    下一个人接手时得先读实现才知道哪个是哪个,而频道名恰恰是最该自解释的地方。
  */
  'websearch:list': { req: void; res: SearchProviderStatus[] }
  'websearch:setEnabled': { req: { id: SearchProviderId; enabled: boolean }; res: void }
  /** 拖拽排序的落点。全量给一遍顺序,而不是 `{from,to}` —— 界面已经算好了 */
  'websearch:reorder': { req: { ids: SearchProviderId[] }; res: void }
  /** ★ 只写不读,和 `provider:setCredential` 同一条规矩(方案 §9) */
  'websearch:setCredential': { req: { id: SearchProviderId; apiKey: string }; res: CredentialInfo }
  'websearch:clearCredential': { req: { id: SearchProviderId }; res: void }
  /**
   * 真发一次最小查询。**不返回搜索结果**,只返回通不通 ——
   * 返回结果的话这条频道就成了一个绕过工具链、绕过联网开关的搜索入口。
   */
  'websearch:test': {
    req: { id: SearchProviderId }
    res: { ok: boolean; latencyMs?: number; message?: string }
  }

  // ── 网络代理(设置 › 连接 › 网络)──
  /*
    代理的其余字段都在 `AppSettings.proxy` 里,经 `settings:update` 走 ——
    **只有密码另开频道**。理由和 `provider:setCredential` 一样:`AppSettings`
    是要被 `settings:get` 整个读回渲染层的,密码进了那个类型,就等于每次
    打开设置页都往渲染进程送一次明文。

    回程是 `{hasKey, encryptionAvailable}`,**没有 last4**。API Key 的末四位
    是用来认「我填的是哪一把」的(用户手里往往有好几把);密码只有一个,
    末四位帮不上忙,却实实在在泄了四个字符。
  */
  'proxy:setPassword': { req: { password: string }; res: ProxyPasswordInfo }
  'proxy:clearPassword': { req: void; res: ProxyPasswordInfo }
  'proxy:getPasswordInfo': { req: void; res: ProxyPasswordInfo }

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
  /**
   * ★★ **叫 `fetchModels` 而不是 `listModels`,因为那个名字已经被上面那条占了 ——
   * 而且占的是相反的意思。** 上面那条列的是「本地配置过的别名」,这条是
   * 「去问上游它有哪些模型」。参考文档 `docs/ipc-protocol.md:337` 恰好用
   * `listModels` 表示后者,照抄过来就会得到两个同名、语义相反的频道。
   *
   * 真发一次网络请求,所以是 async 且可能失败(密钥没填 / 这家没有列表端点)。
   */
  'provider:fetchModels': { req: { providerId: string }; res: FetchedModel[] }
  /**
   * 整表替换这家的模型别名。
   *
   * ★ **是「替换」不是「追加」,因为导入弹窗的语义就是替换** ——
   * 参考图那句「取消勾选会从当前列表删除」和按钮上的「更新列表(17/20)」
   * 说的是同一件事:弹窗关掉之后,这家的别名 = 当时勾着的那些,一个不多一个不少。
   * 拆成 upsert/remove 两条的话,渲染层得自己算差集,而算错的表现是
   * 「取消勾选了但它还在」—— 一个没人会去 diff 的静默错。
   *
   * `models` 是**上游真实模型名**(`FetchedModel.id`),顺序即别名表顺序。
   * 上限 `MAX_ALIASES_PER_PROVIDER`,主进程照样拒绝(不只是界面置灰)。
   */
  'provider:setAliases': { req: { providerId: string; models: string[] }; res: ModelAlias[] }
  'provider:test': { req: { providerId: string }; res: { ok: boolean; latencyMs?: number } }
  /** Model management console writes. */
  'model:update': { req: import('../domain/provider').ModelAlias; res: import('../domain/provider').ModelAlias }
  'model:remove': { req: { providerId: string; alias: string }; res: void }
  /** User-created catalogue rows. Provider model discovery never writes here. */
  'modelCatalog:list': { req: void; res: ModelCatalogDefinition[] }
  'modelCatalog:upsert': { req: ModelCatalogDefinition; res: ModelCatalogDefinition }
  'modelCatalog:remove': { req: { id: string }; res: void }

  // ── 本地网关 ──
  'gateway:getStatus': { req: void; res: GatewayStatus }
  'gateway:setEnabled': { req: { enabled: boolean }; res: GatewayStatus }
  'gateway:resetHealth': { req: { providerId?: string }; res: GatewayStatus }

  // ── 数据(界面「数据」页) ──
  'storage:getStats': { req: void; res: StorageStats }
  'storage:vacuum': { req: void; res: StorageStats }
  'storage:openDataDirectory': { req: void; res: void }
  'storage:export': { req: { includeEncryptedKeys?: boolean; password?: string }; res: { path: string; encrypted: boolean; bytes: number } | null }
  'storage:importPreview': { req: void; res: ImportPreview | null }
  'storage:importApply': { req: { password?: string }; res: ImportApplyResult }
  'storage:chooseBackupDirectory': { req: void; res: string | null }
  'storage:getBackupStatus': { req: void; res: BackupStatus }
  'storage:createBackup': { req: { manual?: boolean }; res: BackupStatus }
  'storage:restoreBackup': { req: { confirm?: boolean }; res: RestoreResult | null }
  'storage:cleanupPreview': { req: { kind: 'attachments' | 'age' | 'history' | 'local-data'; age?: CleanupAge }; res: CleanupPreview }
  'storage:cleanupAttachments': { req: void; res: CleanupResult }
  'storage:cleanupByAge': { req: { age: CleanupAge }; res: CleanupResult }
  'storage:clearHistory': { req: void; res: CleanupResult }
  'storage:clearLocalData': { req: { confirm: boolean }; res: { deleted: boolean } }
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

  /**
   * 未发出的输入落盘。★ **`immediate` 分两档,这是与 Tab 布局唯一的不同**:
   *
   * - 草稿每次按键都变 → `false`,走同一个 500ms 防抖,丢失窗口 ≤500ms,代价是半个词。
   * - 入队/插话/编辑/删除是离散低频动作 → `true`,立即写。丢一整条排队消息的代价
   *   远高于丢半个词,而这类操作的频率低到根本不值得防抖。
   *
   * 强杀(kill -9)拦不住任何一档 —— 这正是队列走立即写、只让草稿承担
   * 那 500ms 风险窗口的原因。
   */
  'session:persistInput': {
    sessionId: string
    state: SessionInputState
    immediate: boolean
  }
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
  'terminal:data': { id: string; seq: number; chunk: string }
  'terminal:exit': { id: string; code: number }
  'gateway:status': GatewayStatus
  'gateway:failover': FailoverEvent
  'settings:changed': AppSettings
  'theme:changed': { resolved: ResolvedTheme }
  'workspace:changed': { workspaces: Workspace[] }
  'skills:changed': void
  'mcp:changed': { servers: McpServerStatus[] }
  'websearch:changed': { providers: SearchProviderStatus[] }
  'sessions:changed': { workspaceId?: string }
  'browser:changed': BrowserChange
  'browser:profilesChanged': BrowserProfile[]
  /** The persisted user catalogue changed. Built-in rows are bundled code. */
  'modelCatalog:changed': { custom: ModelCatalogDefinition[] }
  /**
   * 上游供应商或别名变了。**两张表一起带**,因为设置页左列的每一行都是
   * 「供应商 + 它的主别名」—— 只推 providers 的话,改完供应商名字副标题还是旧的,
   * 而那需要渲染层再发一次 `provider:listModels` 才补得回来。
   */
  'provider:changed': { providers: UpstreamProvider[]; models: ModelAlias[] }
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
  'app:copyText': 1,
  'app:openSessionWindow': 1,
  'settings:get': 1,
  'settings:update': 1,
  'theme:importImage': 1,
  'theme:saveImage': 1,
  'theme:listImages': 1,
  'theme:readImage': 1,
  'theme:deleteImage': 1,
  'workspace:list': 1,
  'workspace:pick': 1,
  'workspace:update': 1,
  'workspace:close': 1,
  'workspace:listDir': 1,
  'browser:list': 1,
  'browser:open': 1,
  'browser:navigate': 1,
  'browser:close': 1,
  'browser:profiles': 1,
  'browser:createProfile': 1,
  'browser:deleteProfile': 1,
  'browser:exportCookies': 1,
  'browser:importCookies': 1,
  'browser:clearProfileState': 1,
  'tabs:getInner': 1,
  'session:getInput': 1,
  'attachment:upload': 1,
  'attachment:pick': 1,
  'attachment:remove': 1,
  'attachment:listBySession': 1,
  'sessions:list': 1,
  'sessions:get': 1,
  'sessions:create': 1,
  'sessions:duplicate': 1,
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
  'mcp:setSecrets': 1,
  'mcp:getSecretsInfo': 1,
  'websearch:list': 1,
  'websearch:setEnabled': 1,
  'websearch:reorder': 1,
  'websearch:setCredential': 1,
  'websearch:clearCredential': 1,
  'websearch:test': 1,
  'proxy:setPassword': 1,
  'proxy:clearPassword': 1,
  'proxy:getPasswordInfo': 1,
  'skills:list': 1,
  'skills:setGlobalEnabled': 1,
  'skills:setWorkspaceActive': 1,
  'provider:list': 1,
  'provider:upsert': 1,
  'provider:remove': 1,
  'provider:setCredential': 1,
  'provider:getCredentialInfo': 1,
  'provider:listModels': 1,
  'provider:fetchModels': 1,
  'provider:setAliases': 1,
  'provider:test': 1,
  'model:update': 1,
  'model:remove': 1,
  'modelCatalog:list': 1,
  'modelCatalog:upsert': 1,
  'modelCatalog:remove': 1,
  'gateway:getStatus': 1,
  'gateway:setEnabled': 1,
  'gateway:resetHealth': 1,
  'storage:getStats': 1,
  'storage:vacuum': 1,
  'storage:openDataDirectory': 1,
  'storage:export': 1,
  'storage:importPreview': 1,
  'storage:importApply': 1,
  'storage:chooseBackupDirectory': 1,
  'storage:getBackupStatus': 1,
  'storage:createBackup': 1,
  'storage:restoreBackup': 1,
  'storage:cleanupPreview': 1,
  'storage:cleanupAttachments': 1,
  'storage:cleanupByAge': 1,
  'storage:clearHistory': 1,
  'storage:clearLocalData': 1
} as const satisfies Record<keyof IpcInvokeMap, 1>

export const SEND_CHANNELS = {
  'terminal:write': 1,
  'terminal:resize': 1,
  'window:ready': 1,
  'tabs:persistOuter': 1,
  'tabs:persistInner': 1,
  'session:persistInput': 1
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
  'mcp:changed': 1,
  'provider:changed': 1,
  'websearch:changed': 1,
  'sessions:changed': 1,
  'browser:changed': 1,
  'browser:profilesChanged': 1,
  'modelCatalog:changed': 1
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
