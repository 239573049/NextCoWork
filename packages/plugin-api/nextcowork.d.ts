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

  export interface ToolResult {
    content: { text: string }[]
    isError?: boolean
  }

  export interface Tool<T = Record<string, unknown>> {
    description: string
    /** JSON Schema,**原样下发给上游**,宿主不解释它。 */
    inputSchema: Record<string, unknown>
    readOnly?: boolean
    destructive?: boolean
    needsNetwork?: boolean
    invoke(options: { input: T; callId: string }): Thenable<ToolResult | string>
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

  // ─────────────────────── diagnostics ───────────────────────

  export namespace diagnostics {
    /** 写一条进插件详情页的「活动」标签。排查用,不是给用户看的。 */
    export function log(level: 'info' | 'warn' | 'error', message: string): Thenable<void>
  }
}
