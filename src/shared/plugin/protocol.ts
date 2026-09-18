/**
 * 插件 ↔ 主进程的 RPC 协议。
 *
 * ## ★ 为什么**不复用** `shared/ipc/contract.ts`
 *
 * 那套三张白名单是给**受信任的主窗口**用的。`preload/index.ts` 的注释写得很明白:
 * 「被攻破的渲染层等价于任意文件系统访问」—— 主窗口是我们自己的代码,那份信任
 * 是设计前提。插件宿主**不受信任**:它跑的是第三方代码,而且是从市场下载的。
 *
 * 所以这里是**另一条通道**:独立协议、独立白名单、独立能力校验。两套混在一起的话,
 * 任何一次给主窗口加频道都会顺带给插件开一个口子,而那个口子不会有人注意到。
 *
 * ## 两道检查,顺序不能换
 *
 * ```
 * ① 白名单:这个方法存在吗        ← 不存在直接拒,连参数都不解析
 * ② 能力  :这个插件被批准了吗     ← 查 PluginPermissionState
 * ③ 参数  :收窄(路径/域名/命令)   ← 在 capabilities.ts
 * ④ 行为  :既有八层权限链          ← 和模型自己调工具同一条路
 * ```
 *
 * ①在②之前是有意的:先回答「有没有这个方法」再回答「你能不能用」,
 * 否则未知方法会走到能力表里查不到、然后以「没有权限」的名义被拒 ——
 * 插件作者拼错一个方法名会收到一条完全误导的错误。
 */
import type { PluginPermission } from './permission'

// ─────────────────────────── 方法表 ───────────────────────────

/**
 * 插件能调的全部方法。**每一条都在这里逐个列出**,没有通配。
 *
 * `permission: null` = 不需要任何能力(但仍然要过白名单)。
 */
export interface PluginMethodMap {
  // env —— 只读的宿主身份,不含任何用户数据
  'env.appInfo': { params: Record<string, never>; result: { appName: string; appVersion: string; language: string } }
  'env.openExternal': { params: { url: string }; result: { opened: boolean } }
  'env.clipboardRead': { params: Record<string, never>; result: { text: string } }
  'env.clipboardWrite': { params: { text: string }; result: Record<string, never> }

  /*
    appearance —— 宿主当前的深浅色。
    **不挂权限**(同 `env.appInfo`):它不含用户数据,也不扩展任何访问面,
    而一个连主题都要申请才能读的插件系统,结果是所有插件都申请,权限表失去意义。

    `subscribe` 之后主题变化经 `kind: 'event'` 反向推送(见 `PluginInvocation`)。
    没有 unsubscribe:插件停用时整个宿主页面就销毁了,订阅跟着一起没,
    多一条只能被漏调的 API。
  */
  'appearance.get': { params: Record<string, never>; result: { appearance: 'light' | 'dark' } }
  'appearance.subscribe': { params: Record<string, never>; result: Record<string, never> }

  // l10n / 权限 —— 插件自查,不碰别人
  'permissions.contains': { params: { permissions: PluginPermission[] }; result: { granted: boolean } }
  'permissions.request': { params: { permissions: PluginPermission[]; reasonKey: string }; result: { granted: boolean } }
  'permissions.remove': { params: { permissions: PluginPermission[] }; result: Record<string, never> }

  // storage —— 独立 kv,单插件配额
  'storage.get': { params: { scope: 'global' | 'workspace'; key: string }; result: { value: string | null } }
  'storage.set': { params: { scope: 'global' | 'workspace'; key: string; value: string | null }; result: Record<string, never> }
  'storage.keys': { params: { scope: 'global' | 'workspace' }; result: { keys: string[] } }

  // secrets —— safeStorage 加密,key 强制前缀
  'secrets.get': { params: { key: string }; result: { value: string | null } }
  'secrets.set': { params: { key: string; value: string | null }; result: Record<string, never> }

  // workspace —— 全部限在工作区根内,过 path-guard
  'workspace.folders': { params: Record<string, never>; result: { folders: { id: string; name: string; path: string }[] } }
  'workspace.readFile': { params: { path: string; encoding?: 'utf8' | 'base64' }; result: { data: string; revision: number } }
  'workspace.writeFile': { params: { path: string; data: string; encoding?: 'utf8' | 'base64'; revision?: number }; result: { revision: number } }
  'workspace.deleteFile': { params: { path: string }; result: Record<string, never> }
  'workspace.stat': { params: { path: string }; result: { kind: 'file' | 'dir' | 'missing'; size: number; mtimeMs: number } }
  'workspace.findFiles': { params: { glob: string; limit?: number }; result: { paths: string[] } }

  // process —— 非交互,argv[0] 查白名单,走权限链
  'process.exec': { params: { command: string; args: string[]; cwd?: string; timeoutMs?: number }; result: { code: number; stdout: string; stderr: string } }

  // net —— 逐 URL 匹配 hostPermissions,response 剥成数据
  'net.fetch': { params: { url: string; method?: string; headers?: Record<string, string>; body?: string }; result: { status: number; headers: Record<string, string>; body: string } }

  // scm
  'scm.status': { params: Record<string, never>; result: { branch: string; staged: string[]; unstaged: string[] } }

  // window —— 宿主渲染的 UI,插件不接触宿主 DOM
  'window.showMessage': { params: { kind: 'info' | 'warn' | 'error'; messageKey: string; params?: Record<string, string | number> }; result: Record<string, never> }
  'window.showQuickPick': { params: { items: { id: string; labelKey: string }[]; placeholderKey?: string }; result: { id: string | null } }
  'window.setStatusBarItem': { params: { id: string; textKey: string | null; tooltipKey?: string; command?: string }; result: Record<string, never> }

  // commands / tools —— 注册与自查
  'commands.register': { params: { commandId: string }; result: Record<string, never> }
  'commands.unregister': { params: { commandId: string }; result: Record<string, never> }
  'commands.execute': { params: { commandId: string; args?: unknown }; result: { value: unknown } }
  'tools.register': { params: { name: string; description: string; inputSchema: unknown; readOnly: boolean; destructive: boolean; needsNetwork: boolean; interactive?: boolean }; result: Record<string, never> }
  'tools.unregister': { params: { name: string }; result: Record<string, never> }

  // agent —— 拦截器与上下文提供者的注册(裁决本身走 invocation 反向通道)
  'agent.registerInterceptor': { params: Record<string, never>; result: Record<string, never> }
  'agent.registerContextProvider': { params: Record<string, never>; result: Record<string, never> }

  // customEditors
  'customEditors.register': { params: { viewType: string }; result: Record<string, never> }
  /**
   * 让宿主为某个文件打开这个插件的自定义编辑器 Tab。
   *
   * ★ **插件说不了「打开哪个 Tab」,只能说「打开哪个文件」。** viewType 必须是
   * 它自己 `contributes.customEditors` 里声明过的(主进程核对),path 过工作区
   * 收窄 —— 于是一个插件既开不了别人的编辑器,也指不到工作区之外的文件。
   *
   * ★ 没有配套的 `tabs.close`:关 Tab 是**用户**的动作。给了关闭入口之后,
   * 「我的标签页自己没了」会变成一个没人能解释的现象(同 `configuration` 只读的理由)。
   */
  'tabs.openCustomEditor': { params: { viewType: string; path: string }; result: Record<string, never> }
  /**
   * 脏状态的**唯一来源**。
   *
   * ★ 必须带 `path`:宿主要靠它回答「关掉这个 Tab 之前有没有没存的东西」,
   * 而那个判断是按**文件**做的(见 `stores/documents.ts` 的
   * `confirmDocumentChanges`)。只给一个 documentId 的话,宿主知道「有东西脏了」
   * 却不知道是哪个文件 —— 于是要么每次关 Tab 都拦一下,要么干脆不拦。
   * 后者就是「关 Tab 静默丢图」。
   */
  'customEditors.setDirty': { params: { documentId: string; path: string; dirty: boolean }; result: Record<string, never> }

  /**
   * 设置项 —— 用户在插件详情页里拨的那些开关。
   *
   * ★ 只读,**没有 `configuration.set`**:设置是**用户**的意思,不是插件的。
   * 给了写入口之后,「我明明关掉了」会变成一个没人能解释的现象。
   */
  'configuration.get': { params: Record<string, never>; result: { values: Record<string, boolean | string | number> } }

  // 诊断 —— 插件自己往活动日志里写一条,便于作者排查
  'diagnostics.log': { params: { level: 'info' | 'warn' | 'error'; message: string }; result: Record<string, never> }

  /**
   * 运行中的工具推一条进度 / 一张实时卡片(第 2 层交互式)。
   *
   * ★ **无权限**:它只作用于**这个工具自己这次调用**(按 callId 定位),推不到别处。
   * message / card 都是**易失的**(不进转录),card 经 `sanitizeToolCard` 消毒后
   * 由宿主经 `tool_progress` 事件转发给渲染层。工具已结束或 callId 对不上时静默丢弃。
   */
  'tool.progress': { params: { callId: string; message?: string; card?: unknown }; result: Record<string, never> }

  // ───────── 第 5 层:插件间通信 ─────────

  /** 声明本插件对外导出的 API 方法名(无权限 —— 提供不是消费)。用于 UI/诊断与路由校验。 */
  'plugins.expose': { params: { methods: string[] }; result: Record<string, never> }
  /**
   * 调用另一个插件导出的 API。权限 `plugins` + 目标必须在本清单 `dependencies` 里。
   * 宿主做 broker:唤醒目标 → 转发到它的 `api.call` → 把返回值带回来。
   */
  'plugins.invoke': { params: { target: string; method: string; args: unknown[] }; result: { value: unknown } }
  /** 往一个 topic 广播事件。权限 `plugins`。宿主扇出给该 topic 的订阅者(不含自己)。 */
  'plugins.emitEvent': { params: { topic: string; payload: unknown }; result: Record<string, never> }
  /** 订阅 / 退订一个 topic。权限 `plugins`。 */
  'plugins.subscribeEvent': { params: { topic: string }; result: Record<string, never> }
  'plugins.unsubscribeEvent': { params: { topic: string }; result: Record<string, never> }
}

export type PluginMethod = keyof PluginMethodMap
export type PluginParams<M extends PluginMethod> = PluginMethodMap[M]['params']
export type PluginResult<M extends PluginMethod> = PluginMethodMap[M]['result']

/**
 * 运行时白名单。
 *
 * `satisfies Record<PluginMethod, PluginPermission | null>` 是**双向**约束,
 * 与 `shared/ipc/contract.ts` 的三张白名单同一手法:
 * - 方法表里加一个却忘了在这里给能力 → Record 缺 key,编译报错
 * - 这里多写一个 → 多余属性检查,编译报错
 *
 * 所以「每个方法都明确声明了它要哪条能力」是编译期可执行的保证。
 */
export const PLUGIN_METHOD_PERMISSION = {
  'env.appInfo': null,
  'env.openExternal': null,
  'env.clipboardRead': 'clipboard',
  'env.clipboardWrite': 'clipboard',

  'appearance.get': null,
  'appearance.subscribe': null,

  'permissions.contains': null,
  'permissions.request': null,
  'permissions.remove': null,

  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.keys': 'storage',

  'secrets.get': 'secrets',
  'secrets.set': 'secrets',

  'workspace.folders': 'workspace.read',
  'workspace.readFile': 'workspace.read',
  'workspace.writeFile': 'workspace.write',
  'workspace.deleteFile': 'workspace.write',
  'workspace.stat': 'workspace.read',
  'workspace.findFiles': 'workspace.read',

  'process.exec': 'process',

  'net.fetch': 'net',

  'scm.status': 'scm.read',

  'window.showMessage': 'window.notify',
  'window.showQuickPick': null,
  'window.setStatusBarItem': null,

  'commands.register': null,
  'commands.unregister': null,
  'commands.execute': null,
  'tools.register': null,
  'tools.unregister': null,

  'agent.registerInterceptor': 'agent.intercept',
  'agent.registerContextProvider': 'agent.context',

  'customEditors.register': 'workspace.read',
  'customEditors.setDirty': null,
  /*
    读能力就够:它打开的是一个**只读到文件内容**的编辑器视图。
    真正的写发生在视图保存时,那条路由渲染层按 Tab 绑定的文件代发,
    并且会再过一次 `workspace:writeFile` 的既有校验。
  */
  'tabs.openCustomEditor': 'workspace.read',

  'configuration.get': null,

  'diagnostics.log': null,

  'tool.progress': null,

  'plugins.expose': null,
  'plugins.invoke': 'plugins',
  'plugins.emitEvent': 'plugins',
  'plugins.subscribeEvent': 'plugins',
  'plugins.unsubscribeEvent': 'plugins'
} satisfies Record<PluginMethod, PluginPermission | null>

export function isPluginMethod(value: unknown): value is PluginMethod {
  return typeof value === 'string' && Object.hasOwn(PLUGIN_METHOD_PERMISSION, value)
}

// ─────────────────────────── 报文 ───────────────────────────

export interface PluginRequest {
  id: number
  method: string
  params: unknown
}

export type PluginErrorCode =
  /** 方法不在白名单里 —— 拼错方法名会收到这个,而不是「没有权限」 */
  | 'unknown_method'
  /** 声明了但用户没批 / 清单里根本没声明 */
  | 'permission_denied'
  /** 参数门:路径越界、域名不在 hostPermissions、命令不在白名单 */
  | 'invalid_argument'
  /** 行为门:既有权限链拒了(用户点了拒绝,或规则命中 deny) */
  | 'rejected'
  | 'timeout'
  | 'aborted'
  /** 插件自己的代码抛了 */
  | 'plugin_error'
  /** 宿主侧出错 */
  | 'internal_error'
  /** 这一版还没实现(见 unsupported.ts) */
  | 'not_implemented'

export type PluginResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: { code: PluginErrorCode; message: string } }

/** 宿主 → 插件的反向调用。插件侧用同一个 id 回一条 `PluginInvocationResult`。 */
export interface PluginInvocation {
  id: number
  kind:
    | 'activate'
    | 'deactivate'
    | 'tool.execute'
    | 'tool.abort'
    /** 用户点了实时卡片上的按钮 —— 送给仍在运行的那次工具调用(第 2 层) */
    | 'tool.action'
    | 'command.run'
    | 'event'
    | 'interceptor.willInvoke'
    | 'interceptor.didInvoke'
    | 'context.provide'
    | 'customEditor.load'
    | 'customEditor.save'
    /** 宿主 → 目标插件:调用它导出的 API 方法(第 5 层) */
    | 'api.call'
    /** 宿主 → 订阅者:投递一条插件事件(第 5 层) */
    | 'plugins.event'
  payload: unknown
}

export type PluginInvocationResult =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: { code: PluginErrorCode; message: string } }

export type PluginMessage =
  | { type: 'request'; request: PluginRequest }
  | { type: 'response'; response: PluginResponse }
  | { type: 'invoke'; invocation: PluginInvocation }
  | { type: 'invokeResult'; result: PluginInvocationResult }
  /** 插件宿主页面握手完成,告诉主进程它已经可以收 invocation 了 */
  | { type: 'ready'; pluginId: string }

// ─────────────────────────── 超时预算 ───────────────────────────

/**
 * 这几个数字与既有机制对齐,不是拍的:
 *
 * - `TOOL` 对齐 `mcp/bridge.ts` 的 `CALL_TOOL_TIMEOUT_MS`;
 * - `INTERCEPTOR` 对齐 `kernel/hook/run.ts` 的裁决超时,而且**超时 = 弃权**
 *   (fail-open,只记诊断)—— 一个卡住的插件不该把所有工具调用堵死;
 * - `ABORT_GRACE` 之后按工具失败返回,run 继续。
 */
export const PLUGIN_TIMEOUT = {
  ACTIVATE_MS: 10_000,
  TOOL_MS: 60_000,
  /**
   * 交互式工具的硬上限(第 2 层)——工具挂起等用户点按钮,60s 太短。
   *
   * ★ 这是**宿主的最后一道闸**(fork B):不信插件会自律地超时,取消随时可用
   * (= abort),但一个声明了 interactive 却永不返回的工具最多把这一轮钉 5 分钟。
   */
  INTERACTIVE_TOOL_MS: 5 * 60_000,
  INTERCEPTOR_MS: 3_000,
  CONTEXT_MS: 3_000,
  COMMAND_MS: 30_000,
  REQUEST_MS: 30_000,
  ABORT_GRACE_MS: 2_000
} as const

/** `agent.registerContextProvider` 的注入上限(计划 §14 第 4 条)。 */
export const PLUGIN_CONTEXT_LIMIT = {
  /** 单次注入的字符上限 */
  PER_CALL: 2000,
  /** 每轮所有插件加起来的字符上限 */
  PER_TURN: 8000
} as const

/** 单插件的 kv 配额。 */
export const PLUGIN_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024
