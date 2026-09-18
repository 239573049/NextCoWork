/**
 * `nextcowork` —— NextCoWork 插件 API。
 *
 * 作者侧的用法与 VS Code 完全一致:
 *
 * ```ts
 * import * as ncw from 'nextcowork'
 *
 * export function activate(context: ncw.ExtensionContext): void { }
 * export function deactivate(): void { }
 * ```
 *
 * 打包时把 `nextcowork` 标成 **external**(和 VS Code 的 `vscode` 一样)。
 * 运行期由宿主经 import map 注入实现,而那份实现的**身份是写死的** ——
 * `pluginId` 由协议层决定,不是一个参数,插件伪造不了。
 *
 * ## 这份声明里没有的东西,运行期也不会有
 *
 * 这不是一份「文档」,它是**能力上界的一部分**:没在这里出现的 API,
 * 在运行期会被白名单挡在第一道门外(错误码 `unknown_method`)。
 * 所以一个在编译期通过的插件,不会在运行期遇到「这个方法不存在」。
 *
 * 反过来也成立:**清单里没声明的能力,类型对了也会被拒**(第二道门)。
 * 类型系统管不了「用户批没批」,那是 `permissions` 命名空间的事。
 */
declare module 'nextcowork' {
  /** 这份 API 的版本。与宿主的 `engines.nextcowork` 不是一回事。 */
  export const version: string

  /** 本插件的 `publisher.name`。**由宿主写死**,改它不影响任何一次鉴权。 */
  export const extensionId: string

  export class Disposable {
    constructor(callOnDispose: () => void)
    static from(...items: { dispose(): unknown }[]): Disposable
    dispose(): void
  }

  export interface ExtensionContext {
    readonly extensionId: string
    /**
     * 注册进来的东西会在 `deactivate` 时被统一 dispose。
     *
     * ★ 不放进来的 Disposable **宿主管不着**:插件休眠(空闲 5 分钟)之后
     * 那些监听器还挂着,而下一次激活会再注册一遍。
     */
    readonly subscriptions: { dispose(): unknown }[]
  }

  // ─────────────────────────── env ───────────────────────────

  export namespace env {
    export function appInfo(): Thenable<{ appName: string; appVersion: string; language: string }>
    /** 用系统默认程序打开一个外部链接。宿主会问用户。 */
    export function openExternal(url: string): Thenable<{ opened: boolean }>
    export const clipboard: {
      /** 需要 `clipboard` 能力;读取还需要一次性确认。 */
      readText(): Thenable<string>
      writeText(text: string): Thenable<void>
    }
  }

  // ─────────────────────── permissions ───────────────────────

  export type Permission =
    | 'workspace.read' | 'workspace.write' | 'process' | 'net' | 'secrets' | 'storage'
    | 'scm.read' | 'scm.write' | 'agent.intercept' | 'agent.context' | 'clipboard' | 'window.notify'

  export namespace permissions {
    export function contains(permission: Permission | Permission[]): Thenable<boolean>
    /**
     * 运行期申请能力。
     *
     * ★ **只能要 `permissions ∪ optionalPermissions` 之内的东西。** 之外的
     * 直接返回 `false`,**不弹窗** —— 否则「市场审核看到的能力上界」就不等于
     * 「运行期可获得的能力上界」,而那正是这套模型成立的前提。
     *
     * @param reasonKey **l10n key**,不是句子。它会被宿主 `t()` 之后显示给用户。
     */
    export function request(permissions: Permission[], reasonKey: string): Thenable<boolean>
    export function remove(permissions: Permission[]): Thenable<void>
  }

  // ──────────────────────── workspace ────────────────────────

  export namespace workspace {
    export function folders(): Thenable<{ id: string; name: string; path: string }[]>

    export const fs: {
      /**
       * @param path **工作区相对路径**。绝对路径一律被拒 —— 让每次调用都去
       * 判断「这个绝对路径是不是恰好在工作区里」,在软链、大小写不敏感文件系统、
       * UNC 路径上各有各的坑。
       * @returns `revision` 是写回时的乐观锁凭据。
       */
      readFile(path: string, encoding?: 'utf8' | 'base64'): Thenable<{ data: string; revision: number }>
      /**
       * @param options.revision 上次读到的 revision。盘上变过就拒绝写入 ——
       * **Agent 和你可能在同时改同一个文件**。
       */
      writeFile(path: string, data: string, options?: { encoding?: 'utf8' | 'base64'; revision?: number }): Thenable<{ revision: number }>
      delete(path: string): Thenable<void>
      stat(path: string): Thenable<{ kind: 'file' | 'dir' | 'missing'; size: number; mtimeMs: number }>
    }

    /** 只支持前缀 glob(`src/**`、`docs/*.md`)。要更强的匹配,取回来自己筛。 */
    export function findFiles(glob: string, limit?: number): Thenable<string[]>
  }

  // ───────────────────────── process ─────────────────────────

  export namespace process {
    /**
     * 跑一条**非交互**命令。
     *
     * ★ `command` 必须命中清单里的白名单(只比对 argv[0] 的基名),
     * 且每次调用都走完整的审批链 —— 和用户手敲一条命令走的是同一条路。
     * ★ 拿不到 `ChildProcess`:回来的只有 code / stdout / stderr。
     */
    export function exec(
      command: string,
      args?: string[],
      options?: { cwd?: string; timeoutMs?: number }
    ): Thenable<{ code: number; stdout: string; stderr: string }>
  }

  // ─────────────────────────── net ───────────────────────────

  export namespace net {
    /**
     * 发一条 https 请求。
     *
     * ★ 插件的页面**出不了网**(CSP 的 `connect-src` 不给外网),所有请求
     * 都必须走这里 —— 于是「这个插件访问了哪些域名」变成主进程可校验、
     * 可审计、可关闭的一条通道。
     * ★ 逐 URL 匹配清单里的 `hostPermissions`;内网与环回地址一律拒绝。
     * ★ 回来的是**数据**,不是 `Response`:没有流句柄可以继续操作。
     */
    export function fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string }
    ): Thenable<{ status: number; headers: Record<string, string>; body: string }>
  }

  // ───────────────────── storage / secrets ───────────────────

  export interface Memento {
    get(key: string): Thenable<string | null>
    set(key: string, value: string | null): Thenable<void>
    keys(): Thenable<string[]>
  }

  export const storage: {
    /** 跟着这台机器走。 */
    global: Memento
    /** 跟着当前工作区走。 */
    workspace: Memento
  }

  /** `safeStorage` 加密。key 会被宿主自动加上 `plugin:<id>:` 前缀。 */
  export const secrets: {
    get(key: string): Thenable<string | null>
    set(key: string, value: string | null): Thenable<void>
  }

  // ───────────────────── configuration ───────────────────────

  export namespace configuration {
    /**
     * 用户在插件详情页里拨的那些开关,合上清单里的默认值。
     *
     * ★ **只读。** 设置是用户的意思,不是插件的 —— 给了写入口之后,
     * 「我明明关掉了」会变成一个没人能解释的现象。
     */
    export function get(): Thenable<Record<string, boolean | string | number>>
  }

  // ───────────────────────── window ──────────────────────────

  export namespace window {
    /** @param messageKey **l10n key**,不是句子。需要 `window.notify` 能力。 */
    export function showMessage(
      kind: 'info' | 'warn' | 'error',
      messageKey: string,
      params?: Record<string, string | number>
    ): Thenable<void>

    /**
     * 由**宿主**渲染的选择器。
     *
     * ★ 插件弹不了自己的菜单 —— 它的 UI 在一个跨源 iframe 里,碰不到宿主 DOM。
     * 这不是限制,是那条边界本身:插件画不出一个看起来像系统菜单的东西。
     */
    export function showQuickPick(
      items: { id: string; labelKey: string }[],
      placeholderKey?: string
    ): Thenable<string | null>

    /**
     * 挂一格状态栏。`textKey` 传 `null` 摘掉它。
     *
     * ★ 每个插件**最多 3 格**,`textKey` 必须是 l10n key,`command` 必须是
     * 自己贡献过的命令。
     */
    export function setStatusBarItem(
      id: string,
      textKey: string | null,
      options?: { tooltipKey?: string; command?: string }
    ): Thenable<void>
  }

  // ────────────────────────── tabs ───────────────────────────

  export namespace tabs {
    /**
     * 为某个工作区文件打开**你自己的**自定义编辑器 Tab。
     *
     * ```ts
     * await ncw.workspace.fs.writeFile('drawings/new.excalidraw', '{}')
     * await ncw.tabs.openCustomEditor('acme.editor', 'drawings/new.excalidraw')
     * ```
     *
     * - `viewType` 必须出现在你的 `contributes.customEditors` 里,否则这次调用
     *   被静默忽略 —— 你开不了别人的编辑器;
     * - `path` 是**工作区相对路径**,跑到根外面会被拒;
     * - 需要 `workspace.read` 能力。
     *
     * ★ 没有配套的关闭方法:关 Tab 是**用户**的动作。
     */
    export function openCustomEditor(viewType: string, path: string): Thenable<void>
  }

  // ──────────────────────── commands ─────────────────────────

  export namespace commands {
    /**
     * @param commandId 必须是清单 `contributes.commands` 里声明过的 ——
     * 没声明的会被静默忽略(菜单、快捷键、命令面板都按 id 分发,
     * 允许运行期注册任意 id 等于让插件能劫持别人的命令)。
     */
    export function registerCommand(commandId: string, handler: (args?: unknown) => unknown): Disposable
    /** ★ 只能执行**自己**贡献的命令。跨插件调用会被拒。 */
    export function executeCommand(commandId: string, args?: unknown): Thenable<unknown>
  }

  // ────────────────────────── tools ──────────────────────────

  /** 卡片里状态/键值的语义色调 —— 宿主映射到主题色,插件不能直接给颜色值。 */
  export type CardTone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger'

  /**
   * 声明式卡片的原语块。由宿主的可信渲染器解释,**插件代码不进渲染路径**。
   * 未知块 / 越界字段会被宿主丢弃或钳制(不是报错)。
   */
  export type CardBlock =
    | { type: 'keyValue'; rows: Array<{ label: string; value: string; tone?: CardTone }> }
    | { type: 'table'; columns: string[]; rows: string[][] }
    | { type: 'status'; label: string; tone?: CardTone }
    | { type: 'text'; value: string }
    | { type: 'code'; value: string; language?: string }
    /** dataRef 只接受 `ncw://`(受管附件)或 `data:`(内联)。 */
    | { type: 'image'; dataRef: string; alt?: string }
    | { type: 'progress'; fraction: number; label?: string }
    /** href 只接受 https;宿主经系统默认程序打开,不在应用内导航。 */
    | { type: 'link'; href: string; label?: string }
    /**
     * 交互按钮:点了走反向通道回到**仍在运行**的工具(见 `Tool.invoke` 的 `onAction`)。
     * 只在实时卡片(经 `progress`)上有意义;工具已返回后点它无效果。
     */
    | { type: 'button'; actionId: string; label: string; tone?: CardTone }

  /**
   * 工具结果的自定义卡片 —— **只影响 UI,不下发给模型**。
   *
   * - `declarative`:一组白名单原语,安全轻量,覆盖多数场景。
   * - `frame`:用你自己的 `contributes.cardViews` 页面渲染任意 UI;`viewType`
   *   必须在清单里声明过,`data` 会被单向推入卡片 iframe(只读)。
   */
  export type ToolCard =
    | { kind: 'declarative'; blocks: CardBlock[] }
    | { kind: 'frame'; viewType: string; data: unknown }

  export interface ToolResult {
    content: { text: string }[]
    isError?: boolean
    /**
     * 可选的自定义结果卡片。宿主会校验(白名单原语、尺寸上限、scheme、frame viewType
     * 必须已声明);不合法则**静默丢弃卡片、只保留文本**。
     */
    card?: ToolCard
  }

  /** 运行中推进度 / 一张实时卡片。message / card 都是易失的(不进转录)。 */
  export interface ToolProgressUpdate {
    /** 一行进度文字,显示在折叠态工具行右侧 */
    message?: string
    /**
     * 实时卡片(第 2 层)。工具还没返回就先给一张可交互的卡;宿主会像结果卡片一样
     * 校验它(白名单原语、frame viewType 必须已声明)。反复调用 = 覆盖上一张。
     */
    card?: ToolCard
  }

  /** 用户在实时卡片的某个 `button` 上的动作。 */
  export interface CardAction {
    actionId: string
    value?: unknown
  }

  export interface Tool<T = Record<string, unknown>> {
    description: string
    /** JSON Schema,**原样下发给上游**,宿主不解释它。 */
    inputSchema: Record<string, unknown>
    readOnly?: boolean
    destructive?: boolean
    needsNetwork?: boolean
    /**
     * 声明这是一个**交互式**工具:它会推一张带按钮的实时卡片并挂起等用户点。
     * 宿主据此放宽这次调用的超时到交互硬上限(否则会撞上常规 60s 超时);
     * 用户随时可取消(= abort)。
     */
    interactive?: boolean
    invoke(options: {
      input: T
      callId: string
      /** 运行中推进度 / 实时卡片 —— 工具还在跑时调用,见 `ToolProgressUpdate`。 */
      progress: (update: ToolProgressUpdate) => void
      /**
       * 注册用户在实时卡片按钮上的动作回调。典型用法:推一张带按钮的卡,
       * 然后 `await new Promise((r) => onAction((a) => r(a)))` 挂起等点击,再据此返回结果。
       */
      onAction: (handler: (action: CardAction) => void) => void
    }): Thenable<ToolResult | string>
  }

  export namespace tools {
    /**
     * 贡献一个 Agent 工具。
     *
     * ★ `name` 必须在清单 `contributes.tools` 里声明过。工具进的是和内置工具、
     * MCP 工具**同一张表**,宿主会加 `plugin__<id>__` 前缀去重 —— 两个插件
     * 各注册一个 `search` 不会互相顶掉。
     */
    export function registerTool<T>(name: string, tool: Tool<T>): Disposable
  }

  // ─────────────────────── plugins(插件间通信) ───────────────────────

  export namespace plugins {
    /**
     * 对外导出一组可被别的插件调用的方法。**无需权限** —— 提供不是消费。
     * 方法名的集合就是你的 API 表面;调用方经 `connect(你的 id)` 拿到代理来调。
     */
    export function exposeApi(methods: Record<string, (...args: any[]) => unknown>): Disposable

    /**
     * 连接另一个插件导出的 API,拿到一个调用代理:`connect(id).foo(1, 2)` 会跨插件
     * 调到对方 `exposeApi` 里的 `foo`,返回值经 Promise 带回。
     *
     * ★ 需要 `plugins` 能力,且 `pluginId` 必须在你的清单 `dependencies` 里声明过 ——
     * 两道门都过不了则调用返回 `null`。目标在睡会被自动唤醒。
     */
    export function connect<T = Record<string, (...args: any[]) => Promise<any>>>(pluginId: string): T

    /** 松耦合事件总线。需要 `plugins` 能力。topic 建议加命名空间前缀避免撞车。 */
    export namespace events {
      /** 往一个 topic 广播。宿主扇出给订阅者(不含自己),只投给正在运行的。 */
      export function emit(topic: string, payload?: unknown): Thenable<void>
      /** 订阅一个 topic。`from` 是发出者的 pluginId。返回的 Disposable 用于退订。 */
      export function on(topic: string, handler: (payload: unknown, from?: string) => void): Disposable
    }
  }

  // ─────────────────────── diagnostics ───────────────────────

  export namespace diagnostics {
    /** 写一条进插件详情页的「活动」标签。排查用,不是给用户看的。 */
    export function log(level: 'info' | 'warn' | 'error', message: string): Thenable<void>
  }

  // ─────────────────────── appearance ───────────────────────

  /**
   * 宿主的深浅色。**不需要任何权限** —— 同 `env.appInfo`。
   *
   * ★ 这套 API 是给**插件逻辑**(extension.ts)用的。插件的**视图** iframe
   * 里另有一套、且不用调任何 API:宿主会把 24 个颜色 token 写成 `--ncw-<token>`
   * CSS 变量,并在 `<html>` 上同步 `data-theme`。视图侧要在 JS 里跟随的话,
   * 读 `globalThis.__ncwTheme` 或监听 window 上的 `ncw:theme` 事件。
   */
  export namespace appearance {
    export function get(): Thenable<'light' | 'dark'>

    /**
     * 主题变化时回调。返回的 `Disposable` 用来取消。
     *
     * ★ 插件**休眠期间不会收到**回调(空闲五分钟后宿主页面会被销毁)。
     * 这是有意的:没人在用的插件不值得为一次颜色变化叫醒。下次被唤醒时
     * `get()` 拿到的就是最新值,所以别把「收到过几次回调」当状态用。
     */
    export function onDidChange(handler: (appearance: 'light' | 'dark') => unknown): Disposable
  }
}
