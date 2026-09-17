# 计划:NextCoWork 插件系统 + CoWork 插件市场

## 0. 结论先行

为本产品建立一套 **VS Code Extension Host 形态**的插件系统:

- **包格式**:用 `package.json` + `contributes` + `activationEvents`,字段名尽量与 VS Code 同名。
- **代码宿主**:一个隐藏的沙箱 `BrowserWindow`,内部为每个插件创建一个 `ncw-plugin://<pluginId>` 源下的 `<iframe>`;Chromium 的站点隔离自动把它们分到不同 renderer 进程。
- **能力模型**:插件永远拿不到裸句柄(`fs`/`spawn`/`net`/`secrets`),只有 `ncw.*` facade;每一条 API 都经过「静态声明 → 安装批准 → 参数收窄 → 既有权限链」四道门。
- **UI**:声明式贡献(视图/命令/菜单/快捷键/状态栏/设置)+ 受控 webview(隔离 iframe),插件不接触宿主 DOM。
- **市场**:CoWork 侧新建与 Skills 市场平行的 `plugins` / `plugin_versions` 表与端点;客户端复用现有「授权 → digest → 下载 → 校验 sha256 → 安装」四步流程。

**验收用例是 Excalidraw 插件**,而且——这是本计划的一条硬约束——**它必须是纯第三方插件**:

- 由用户自己开发、自己打包、自己上传到 CoWork 市场,不能进 `resources/skills` 那一类内置资源,不能有任何内置特权。
- 因此插件系统的**唯一验收标准是**:作者只读公开文档、只用公开工具链(`create-nextcowork-plugin` / `@aidotnet/plugin-cli` / `@aidotnet/plugin-api`),就能从零做出一个能上架的 Excalidraw 插件。
- 任何"给自己开后门"的做法(内置插件走特殊路径、API 需要内部约定才能用)都被这条约束排除。

Excalidraw 同时压测了:自定义编辑器 + 文件类型绑定 + 脏状态/保存 + 大体积 webview + 二进制 IO + 主题同步 + Agent 工具 + 外部变更冲突。它能跑通,API 完备性就够。

---

## 1. 目标与范围

### 1.1 本计划要做

**NextCoWork(桌面端)** — 仓库 `/Users/token/Desktop/code/NextCoWork`:

1. 还清三项前置技术债(i18n 运行时注册、资源注册表 workspace 分桶、工具注册表参数化)。
2. 建立插件宿主:协议、宿主窗口、RPC、清单解析、能力批准、安装/启用/禁用/卸载。
3. 开放 Agent 侧贡献点(工具、拦截器、上下文)+ 应用侧贡献点(菜单、视图、命令、快捷键、状态栏、主题、设置)。
4. 开放 `contributes.customEditors`,让插件能接管文件类型。
5. 修掉 `+` 菜单的硬编码中文与 `kind` 三元耦合,改造成 `contributes.menus`。
6. 接上 CoWork 市场:浏览、安装、更新、卸载、发布入口。

**CoWork(后端)** — 仓库 `/Users/token/Desktop/code/CoWork`:

7. 新建 `plugins` / `plugin_versions` 表与 `PluginEndpoints`,含 draft→pending→published 审核流、能力差异审查、`engines` 版本过滤。

### 1.2 本计划明确不做

- 不做内置插件。仓库现有 6 套内置扩展机制(Skill / Command / Agent / Mode / Hook / MCP)**保持不变**,插件不接管它们。
- 不实现 `contributes.chatRenderers`(聊天内嵌渲染插件 UI)。记为后续期。
- 不实现 `process.createTerminal`。交互式 pty 的输入无法过审批链,单列后续。
- 不实现 debug / task / notebook 类贡献点。
- 不实现插件的自动更新(先做"检查更新 + 手动确认")。
- 不动 `db/sql/migration.sql` 里与插件无关的结构。

### 1.3 与既有约定的关系

- 依赖方向不变:`shared ← kernel ← runtime ← ipc ← index`。`kernel/**` 与 `runtime.ts` **不得** import `electron` / `ipc` / `window`(`runtime.ts:4-13` 写死了这条)。
- 所有用户可见文案走 `src/renderer/src/i18n/`,不新增 JSX 裸文案(项目 AGENTS.md)。本计划含一项 **修既有违规** 的工作。
- 主进程侧新增代码不得引入用户可见裸文本;需要传达给 UI 的文案一律传 key(见 §8)。

---

## 2. 包格式:`package.json`,对齐 VS Code 命名

### 2.1 清单示例

```jsonc
{
  "name": "excalidraw",
  "publisher": "your-name",
  "displayName": "Excalidraw",
  "description": "在工作区里编辑 .excalidraw 文件,并让 Agent 读写场景",
  "version": "1.0.0",
  "license": "MIT",
  "icon": "assets/icon.png",
  "categories": ["Visualization"],
  "keywords": ["diagram", "excalidraw", "drawing"],

  "engines": { "nextcowork": "^0.2.0" },
  "main": "./dist/extension.js",
  "l10n": "./l10n",

  "activationEvents": [
    "onCustomEditor:excalidraw.editor",
    "onCommand:excalidraw.new"
  ],

  "permissions": ["workspace.read", "workspace.write", "storage"],
  "optionalPermissions": ["net"],
  "hostPermissions": ["https://libraries.excalidraw.com/*"],

  "contributes": {
    "commands": [
      { "command": "excalidraw.new", "title": "%cmd.new%", "icon": "pen-tool" },
      { "command": "excalidraw.exportPng", "title": "%cmd.exportPng%", "icon": "image" }
    ],
    "customEditors": [
      {
        "viewType": "excalidraw.editor",
        "displayName": "%editor.displayName%",
        "selector": [{ "filenamePattern": "*.excalidraw" }],
        "priority": "default"
      }
    ],
    "menus": {
      "tabBar/new": [{ "command": "excalidraw.new", "group": "create@20" }],
      "explorer/context": [
        { "command": "excalidraw.exportPng", "group": "export@10",
          "when": "resourceExtname == .excalidraw" }
      ]
    },
    "keybindings": [
      { "command": "excalidraw.new", "key": "CmdOrCtrl+Alt+D" }
    ],
    "tools": [
      { "name": "read_diagram", "title": "%tool.read%", "icon": "eye" },
      { "name": "edit_diagram", "title": "%tool.edit%", "icon": "pencil" }
    ],
    "skills": [{ "path": "./skills/diagram-authoring" }],
    "configuration": {
      "title": "%config.title%",
      "properties": {
        "excalidraw.gridMode": {
          "type": "boolean", "default": false, "title": "%config.gridMode%"
        }
      }
    }
  }
}
```

### 2.2 字段规则(与本仓库既有机制的对应)

| 字段 | 规则 | 校验位置 |
|---|---|---|
| `name` | `^[a-z0-9][a-z0-9-]{0,63}$`,与后端 `NameRegex` 复用同一形状 | 客户端装载 + 后端上传 |
| `publisher` | `^[a-z0-9][a-z0-9-]{0,63}$` | 同上 |
| 插件 id | `` `${publisher}.${name}` ``,`^[a-z0-9-]+\.[a-z0-9-]+$`,全局唯一 | 同上 |
| `version` | semver,复用后端 `SemVerRegex` | 后端 |
| `engines.nextcowork` | 必填,简单 range(`^` / `~` / `>=` / 精确) | 客户端激活前 + 后端上架时 + 市场列表按当前客户端版本过滤 |
| `main` | 必填,`.js` 后缀,单文件 ESM。**不接受 CommonJS,不接受对 node_modules 的解析** | 客户端装载 |
| `activationEvents` | 白名单化,见 §2.3 | 客户端 + 市场审核提示 |
| `permissions` / `optionalPermissions` | 必须在 §5.1 枚举表内,且**两者并集之外的能力永不可得** | 客户端安装 + 后端审核 |
| `hostPermissions` | 仅当声明 `net` 时有意义,`https://host/path*` 形式 | 客户端 + 主进程逐请求校验 |
| `contributes.*.title` | **必须**是 `%key%` 形式(引用 l10n bundle),不允许裸文案 | 客户端装载 + 后端上传校验 |

### 2.3 `activationEvents` 白名单

| 事件 | 触发时机 |
|---|---|
| `onStartup` | 应用启动。**仅允许极少数插件,市场审核默认驳回** |
| `onWorkspaceContains:<glob>` | 工作区根下匹配到文件(用 `search/` 现有 glob 实现) |
| `onCommand:<commandId>` | 该命令被命令面板/菜单执行 |
| `onView:<viewId>` | 视图首次可见 |
| `onCustomEditor:<viewType>` | 有文件要用该编辑器打开 |
| `onTool:<toolName>` | Agent 首次调用该工具 |
| `onLanguage:<languageId>` | 暂不实现,枚举中不出现 |

**默认策略:懒激活 + 空闲 5 分钟休眠。** `onStartup` 是本架构下唯一的内存风险源,市场审核把它当驳回理由。

### 2.4 包内容

```
<userData>/plugins/<publisher>.<name>/          ← ipc/storage.ts:148 已在删除清单里
  package.json
  dist/extension.js              ← 单文件 ESM
  dist/views/*.html|js|css       ← webview 资源
  l10n/{zh-CN,en-US}.json
  skills/ agents/ modes/ commands/   ← 声明式内容(可选)
  themes/*.json                      ← ThemeProfile 格式(可选)
  assets/*
```

工作区级插件走 `<ws>/.next-cowork/plugins/`。

> ⚠️ `.next-cowork` 这个字面量目前在 `kernel/skill/load.ts:44`、`kernel/command/load.ts:32`、`kernel/agent/load.ts:37`、`kernel/mode/load.ts:18` **各写了一遍**。加第五处之前先合并到 `shared/domain/local-settings.ts`(它已经导出了 `LOCAL_SETTINGS_DIRNAME`),四处改为引用它。

---

## 3. `@aidotnet/plugin-api`:TS API 包

### 3.1 分发形态

三个包,放在一个独立仓库或本仓库的 `packages/` 下(实施时二选一,推荐独立仓库,避免污染桌面端构建):

| 包 | 内容 |
|---|---|
| `@aidotnet/plugin-api` | **只有 `nextcowork.d.ts` + `package.json`**,零运行时代码。`types` 指向该声明文件 |
| `create-nextcowork-plugin` | 脚手架,生成清单 + webview + 打包配置 |
| `@aidotnet/plugin-cli` | `build` / `package` / `publish` / `dev --watch` |

作者写法:

```ts
import * as ncw from 'nextcowork'

export function activate(context: ncw.ExtensionContext): void { /* ... */ }
export function deactivate(): void { /* ... */ }
```

打包时 `nextcowork` 标记为 external(与 VS Code 的 `vscode` 完全一致)。运行期由宿主 iframe 的 import map 注入:

```html
<script type="importmap">
{ "imports": { "nextcowork": "ncw-plugin://runtime/api.js?p=<pluginId>" } }
</script>
```

`api.js` 由宿主生成,闭包捕获 `pluginId` 与该插件专属的 `MessagePort`。**身份由协议层写死,不是参数**,插件伪造不了。

### 3.2 核心原语(照抄 VS Code 形状,不发明新词汇)

```ts
declare module 'nextcowork' {
  export const version: string

  export class Disposable {
    constructor(callOnDispose: () => void)
    static from(...items: { dispose(): unknown }[]): Disposable
    dispose(): void
  }
  export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable
  }
  export class EventEmitter<T> {
    readonly event: Event<T>
    fire(data: T): void
    dispose(): void
  }
  export class Uri {
    static file(path: string): Uri
    static joinPath(base: Uri, ...segments: string[]): Uri
    static parse(value: string): Uri
    readonly scheme: string
    readonly path: string
    readonly fsPath: string
    with(change: { scheme?: string; path?: string }): Uri
    toString(): string
  }
  export interface CancellationToken {
    readonly isCancellationRequested: boolean
    readonly onCancellationRequested: Event<void>
  }
  export class CancellationTokenSource {
    readonly token: CancellationToken
    cancel(): void
    dispose(): void
  }
  /** 图标来自宿主的白名单枚举,不是任意 SVG */
  export class ThemeIcon { constructor(id: MenuIconName) }

  export interface ExtensionContext {
    readonly extensionId: string
    readonly extensionUri: Uri
    readonly extensionMode: 'production' | 'development'
    readonly subscriptions: { dispose(): unknown }[]
    readonly globalState: Memento
    readonly workspaceState: Memento
    readonly secrets: SecretStorage
    readonly permissions: PermissionState
  }
}
```

### 3.3 命名空间总览

| namespace | 主要成员 | 权限门 | 期次 |
|---|---|---|---|
| `env` | `appName` `appVersion` `language` `uriScheme` `openExternal` `clipboard` | 无 / `clipboard` | P1 |
| `commands` | `registerCommand` `executeCommand` `getCommands` | 无(只能自查已注册命令) | P1 |
| `l10n` | `t(key, ...args)` `bundle` | 无 | P1 |
| `permissions` | `contains` `request` `remove` `onDidChange` | 无 | P1 |
| `tools` | `registerTool` `invokeTool` `onDidChangeTools` | 无(注册即声明) | P2 |
| `agent` | `registerToolInterceptor` `registerContextProvider` + 会话事件 | `agent.intercept` / `agent.context` | P2 |
| `workspace` | `workspaceFolders` `fs` `findFiles` `onDidChangeFiles` `getConfiguration` | `workspace.read` / `workspace.write` | P2 |
| `process` | `exec` `spawn`(流式,非交互) | `process` | P2 |
| `net` | `fetch` | `net` + `hostPermissions` | P2 |
| `window` | 消息、QuickPick、InputBox、StatusBarItem、WebviewPanel、Progress、`showSaveDialog` | 无 / `window.notify` | P3 |
| `scm` | `getRepository` `getStatus` `getDiff` `getLog` | `scm.read` / `scm.write` | P3 |
| `customEditors` | `registerCustomEditorProvider` | `workspace.read` `workspace.write` | P3 |

### 3.4 `tools` 命名空间(对齐 VS Code 的 `lm.registerTool`)

```ts
export namespace tools {
  export interface ToolInvocationOptions<T> {
    readonly input: T
    readonly callId: string
    readonly session: agent.SessionInfo
    readonly workspaceUri: Uri | undefined
  }
  export interface ToolResult {
    readonly content: (TextPart | ImagePart)[]
    readonly isError?: boolean
  }
  export interface Tool<T = object> {
    /** 给宿主一个人类可读的确认摘要,进审批弹窗 */
    prepareInvocation?(
      options: ToolInvocationOptions<T>, token: CancellationToken
    ): ProviderResult<{ invocationMessage: string; confirmation?: { title: string; message: string } }>
    invoke(options: ToolInvocationOptions<T>, token: CancellationToken): ProviderResult<ToolResult>
  }
  export function registerTool<T>(name: string, tool: Tool<T>): Disposable
  export function invokeTool(name: string, options: ToolInvocationOptions<unknown>, token: CancellationToken): Thenable<ToolResult>
  export const onDidChangeTools: Event<void>
}
```

`prepareInvocation` 是刻意抄的:它让插件工具的审批弹窗显示人话("将在 3 个 crate 上运行 cargo check")而不是一坨 JSON。

### 3.5 `agent` 命名空间(本产品特有)

```ts
export namespace agent {
  export interface SessionInfo {
    readonly sessionId: string
    readonly runId: string
    readonly workspaceUri: Uri | undefined
    readonly model: string      // 领域值,不翻译
    readonly mode: string
    readonly depth: number      // 0 = 顶层,>0 = 子代理
  }

  export type Verdict =
    | { decision: 'allow' }
    | { decision: 'ask'; reasonKey: string }
    | { decision: 'deny'; reasonKey: string }

  export interface ToolInterceptor {
    /** 执行前。硬超时 3s,超时 = 弃权(fail-open,只记诊断)。★ 只能收紧,不能放宽 */
    willInvoke?(
      e: { readonly toolName: string; readonly input: unknown
           readonly readOnly: boolean; readonly destructive: boolean
           readonly session: SessionInfo },
      token: CancellationToken
    ): ProviderResult<Verdict>

    /** 执行后。★ 只能追加 feedback,不能改写 output */
    didInvoke?(
      e: { readonly toolName: string; readonly result: tools.ToolResult
           readonly session: SessionInfo },
      token: CancellationToken
    ): ProviderResult<{ feedback?: string }>
  }
  export function registerToolInterceptor(i: ToolInterceptor): Disposable

  /** 注入本轮上下文。★ 不是系统提示词 */
  export interface ContextProvider {
    provideContext(e: { prompt: string; session: SessionInfo }, token: CancellationToken): ProviderResult<string>
  }
  export function registerContextProvider(p: ContextProvider): Disposable

  export const onDidStartRun: Event<SessionInfo>
  export const onDidEndRun: Event<SessionInfo & { status: 'done' | 'error' | 'aborted' }>
  export const onDidSubmitPrompt: Event<{ prompt: string; session: SessionInfo }>
}
```

两条约束写进类型注释,因为它们直接对应内核既有不变式:

- `willInvoke` **只能收紧** —— 对应 `kernel/permission-decision.ts:90-100` 的优先级本体。
- `didInvoke` **只能追加** —— 对应 `kernel/agent-session.ts:1015-1019`("不能改 output")。

**不提供 `contributeSystemPrompt`。** 让插件往系统提示词里塞东西,等于给它影响所有 Agent 行为的杠杆,且多插件叠加后不可预测(`context-assembler.ts:461` 那 6 段是精心排过序的)。插件只能通过 `contributes.skills`(用户可见、可禁用、有明确触发条件)与 `registerContextProvider`(有长度上限、强制包裹、UI 可折叠)影响上下文。

### 3.6 `customEditors` 命名空间(照抄 VS Code)

```ts
export namespace customEditors {
  export interface CustomDocument { readonly uri: Uri; dispose(): void }

  export interface CustomEditorProvider<T extends CustomDocument> {
    openCustomDocument(uri: Uri, ctx: { backupId?: string }, token: CancellationToken): Thenable<T>
    resolveCustomEditor(doc: T, panel: WebviewPanel, token: CancellationToken): Thenable<void>

    /** 脏状态的唯一来源。内置 undo 的编辑器用带 undo()/redo() 的 Edit 变体;
     *  自管 undo 栈的(Excalidraw 属于这类)用 ContentChange 变体 */
    readonly onDidChangeCustomDocument: Event<{ document: T }>

    saveCustomDocument(doc: T, token: CancellationToken): Thenable<void>
    saveCustomDocumentAs(doc: T, target: Uri, token: CancellationToken): Thenable<void>
    revertCustomDocument(doc: T, token: CancellationToken): Thenable<void>
    backupCustomDocument(doc: T, ctx: { destination: Uri }, token: CancellationToken):
      Thenable<{ id: string; delete(): void }>
  }

  export function registerCustomEditorProvider<T extends CustomDocument>(
    viewType: string, provider: CustomEditorProvider<T>
  ): Disposable
}
```

宿主侧配套:

- `contributes.customEditors[].selector[].filenamePattern` 与 `InnerTab` 的 `kind: 'custom'` 绑定(见 §7.4)。
- 脏文档必须汇入 `stores/documents.ts:184` 的 `confirmDocumentChanges` —— 该函数目前只问 `documents` store,要泛化成"问所有脏文档源"。**不做这一步,关 Tab 会静默丢图。**
- 写盘走 `writeWorkspaceFile({ revision })` 的乐观锁(参数已存在,见 `documents.ts:133-137`)。

---

## 4. 宿主运行时

### 4.1 进程与窗口布局

```
┌─ main process ────────────────────────────────────────────┐
│  KernelHost (fs/spawn/fetch/secrets)                       │
│  ToolRegistry ◄── builtin ◄── MCP ◄── plugin(RPC proxy)    │
│  PermissionGate / HookChain / ContextAssembler             │
│  plugin/PluginManager  ── 清单/能力批准/生命周期/RPC 路由   │
│  plugin/host-window    ── 隐藏 BrowserWindow               │
└──────────┬──────────────────────────────┬──────────────────┘
           │ MessagePort(能力 RPC)         │ IPC(契约白名单)
┌──────────┴────────────────┐   ┌─────────┴──────────────────┐
│ Plugin Host Window        │   │ Main Window                │
│   show:false, sandbox     │   │  插件的声明式 UI 贡献       │
│  ┌──────┐ ┌──────┐        │   │  受控 webview/iframe       │
│  │iframe│ │iframe│  ...   │   └────────────────────────────┘
│  │  pA  │ │  pB  │        │
│  └──────┘ └──────┘        │
│  origin: ncw-plugin://pA  │
└───────────────────────────┘
```

### 4.2 宿主窗口

```ts
// src/main/plugin/host-window.ts
new BrowserWindow({
  show: false,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false,       // ★ 不设这个,隐藏窗口的 timer 会被降频到 1/min
    partition: 'persist:plugin-host',  // 与主窗口存储完全隔离
    preload: pluginHostPreload         // 只暴露 MessagePort 握手
  }
})
```

四条硬性约定:

1. 宿主窗口**不属于 `window/registry.ts`**,不参与 `emitToAll`。它由 `src/main/index.ts` 的应用生命周期直接持有。
2. `before-quit`(`index.ts:524-552`)里与 `shutdownMcp()` 并列调用 `shutdownPlugins()`。
3. 宿主页面是内置空白页,只负责:接收装载列表 → 为每个插件建 `<iframe src="ncw-plugin://<id>/host.html" sandbox="allow-same-origin allow-scripts">` → 用 `MessageChannel` 把 port 直连主进程。转交完成后宿主页面不在数据通路上。
4. `allow-same-origin` 是必须的(只给 `allow-scripts` 会让 iframe 变成 opaque origin,`localStorage`/`IndexedDB` 全抛异常)。安全性来自 origin 差异(`ncw-plugin://<id>` ≠ `ncw://main`),不是 sandbox 属性。

### 4.3 `ncw-plugin://` 协议

在 `src/main/index.ts:123` 的 `registerAttachmentScheme()` 旁边注册,照抄它 + `installAttachmentProtocol()` 的两段式(该处注释已说明 privileges 在 ready 之后会丢)。

- 只允许读 `<userData>/plugins/<id>/` 下的文件,路径过 `kernel/tool/path-guard.ts` 同款校验(realpath 归一,挡软链)。
- 由协议 handler **强制注入** CSP 响应头:

```
default-src 'none';
script-src  'self' 'wasm-unsafe-eval';
style-src   'self' 'unsafe-inline';
font-src    'self' data:;
img-src     'self' data: blob:;
media-src   blob:;
worker-src  blob:;
connect-src 'self' data: blob:;      ← 仍然禁外网:所有网络请求必须走 ncw.net.fetch
frame-ancestors ncw://main;
```

`connect-src` 不给外网是关键设计,不是疏漏:它让"插件能访问哪些域名"变成主进程可校验、可审计、可关闭的一条通道。

### 4.4 RPC 协议

**不复用 `shared/ipc/contract.ts` 的三张白名单。** 那套是给受信任的主窗口用的(`preload/index.ts:38-56` 的注释已写明"被攻破的渲染层等价于任意文件系统访问")。插件宿主是不受信任的,必须独立协议 + 独立白名单 + 独立能力校验。

```ts
// src/shared/plugin/protocol.ts(新建)

export interface PluginRequest { id: number; method: PluginMethod; params: unknown }

export type PluginResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: { code: PluginErrorCode; message: string } }

export interface PluginInvocation {
  id: number
  kind: 'activate' | 'deactivate' | 'tool.execute' | 'tool.abort'
      | 'command.run' | 'event' | 'customEditor.load' | 'customEditor.save'
  payload: unknown
}

export type PluginMethod = keyof PluginMethodMap
// PluginMethodMap 用 `satisfies Record<keyof PluginMethodMap, 1>` 做双向完备性约束,
// 与 contract.ts:935-946 的三张白名单同一手法。
```

主进程侧对每个请求做**两道**检查:白名单(方法存在)+ 能力(该插件被批准了吗)。

### 4.5 超时与故障(与 MCP 对齐)

| 场景 | 处理 |
|---|---|
| `tool.execute` | 60s 硬超时(对齐 `mcp/bridge.ts:42` 的 `CALL_TOOL_TIMEOUT_MS`) |
| `willInvoke` | 3s 硬超时,超时 = 弃权(fail-open,只记诊断,同 `kernel/hook/run.ts:23-28`) |
| `activate` | 10s 硬超时 |
| 用户点停止 | 主进程 abort → 发 `tool.abort` → 2s 宽限 → 超时按工具失败返回,run 继续。**注意** `kernel/tool/define.ts:74` 的约定:中断要原样抛、不能伪装成工具失败 |
| iframe 崩溃 | `unregisterBySource({kind:'plugin',pluginId})` **先于**重建(同 `mcp/manager.ts:264` 的"下线先于关闭");进行中的调用全部 reject 成 `toolFail` |
| 插件禁用/卸载 | `unregisterBySource` → `deactivate` → 销毁 iframe → 级联清理该插件的主题/命令/状态栏/kv/翻译 |

### 4.6 主进程模块清单(新建)

```
src/main/plugin/
  manager.ts          生命周期、清单解析、激活事件、休眠
  host-window.ts      宿主 BrowserWindow + 协议注册
  host-preload.ts     宿主页面 preload(只做 MessagePort 握手)
  rpc.ts              请求路由、白名单、能力校验、超时
  capabilities.ts     能力枚举、批准状态、参数收窄(路径/域名/命令白名单)
  tools.ts            ToolRegistry 桥接
  interceptor.ts      agent 拦截器 → decideAfterHooks
  context.ts          ContextProvider → 注入块
  installer.ts        本地目录 / ZIP / 市场包安装(复用 kernel/skill/install.ts 的防线)
  diagnostics.ts      环形缓冲活动日志(照抄 main/hooks.ts:30-47)
  unsupported.ts      §11 的降级提示

src/shared/plugin/
  manifest.ts         package.json 类型 + 运行时校验器(zod 已在依赖里)
  protocol.ts         RPC 协议 + 方法映射
  permission.ts       能力枚举 + PermissionState
  contribution.ts     贡献点类型 + 合并逻辑(纯函数,可在 node 环境测)
```

接入点:`src/main/ipc/index.ts:694-740` 那串接线里加 `registerPluginBridge()` 与 `pluginManager.start()`;`src/main/index.ts:437` 的 `initRuntime(host)` 之后启动。

---

## 5. 权限模型

### 5.1 能力枚举

| permission | 开什么 | 参数门 | 行为门 |
|---|---|---|---|
| `workspace.read` | `workspace.fs.read*` `findFiles` `openTextDocument` | 限工作区根内,过 `path-guard.ts` 的 `resolveInWorkspace` | 只读 → `evaluate()` 直接 allow |
| `workspace.write` | `fs.writeFile` `delete` `rename` | 同上 + 清单可选 `paths` glob 再收窄 | **走完整八层权限链** |
| `process` | `process.exec` `spawn`(非交互) | 清单 `commands` 白名单,匹配 `argv[0]` | **走完整权限链**,`destructive=true` |
| `net` | `net.fetch` | `hostPermissions` 逐 URL 校验(**在主进程做**) | `needsNetwork=true` → 联网开关关闭时直接 deny |
| `secrets` | `context.secrets` | key 强制前缀 `plugin:<id>:`,`safeStorage` 加密 | 无 |
| `storage` | `globalState` / `workspaceState` | 独立 kv 表,单插件配额 5MB | 无 |
| `scm.read` / `scm.write` | git 状态/diff/log ‖ commit/branch | 限当前工作区仓库 | write 走权限链 |
| `agent.intercept` | `registerToolInterceptor` | — | 只能收紧 |
| `agent.context` | `registerContextProvider` | 注入长度上限 + 强制 `<plugin-context source="...">` 包裹 | — |
| `clipboard` | 剪贴板读写 | 读需一次性确认 | — |
| `window.notify` | 系统通知 | 频率限流 | — |

**没有 `*`,没有 `all_urls`。** 每一项逐条声明、逐条批准。

### 5.2 四道门

```
插件代码(只有 facade,没有任何原生句柄)
   ▼
① 静态门:清单声明 + 市场审核    → 未声明的 API 在 d.ts 层面不可见,运行期双拒
   ▼
② 授予门:安装/升级时用户逐条勾选 → permissions 必选,optionalPermissions 运行时再要
   ▼
③ 参数门:每次调用的参数收窄     → 路径/域名/命令白名单,主进程校验(不信 CSP)
   ▼
④ 行为门:既有八层权限链 + 审批弹窗 → 与用户手敲命令、与 MCP 工具完全同一条路
   ▼
KernelHost(fs / spawn / net.fetch / secrets)
```

### 5.3 运行时申请

```ts
export namespace permissions {
  export function contains(p: Permission | Permission[]): Thenable<boolean>
  /** reasonKey 必须是 l10n key */
  export function request(p: Permission[], reasonKey: string): Thenable<boolean>
  export function remove(p: Permission[]): Thenable<void>
  export const onDidChange: Event<{ granted: Permission[]; revoked: Permission[] }>
}
```

**铁律:`request()` 只能要 `permissions ∪ optionalPermissions` 之内的东西,之外的直接拒绝、不弹窗。** 这样"市场审核看到的能力上界"永远等于"运行时可获得的能力上界",堵死"装完之后自动更新悄悄扩权"这条路。

配套:**升级时 `permissions` 集合变大 → 插件进入 `disabled-pending-approval` 状态**,用户不批不激活。后端 DTO 带 `permissionEscalated: true`,审核台标红。

### 5.4 零裸句柄:三个具体例子

| 插件想干的事 | 给不给 | 怎么给 |
|---|---|---|
| 读文件 | 给 | `fs.readFile(uri)` → RPC → 主进程 realpath 归一(`path-guard.ts:49-87`)→ 校验在批准根内 → 读 → 返回 `Uint8Array`。**拿不到 fd、拿不到绝对路径以外的东西** |
| 跑命令 | 给 | `process.exec('cargo', ['check'])` → argv[0] 查白名单 → 进权限链 → `kernel/node-spawn.ts` 起进程(进程组 + `killTree` + 摘掉 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`)→ 流式回传 stdout/stderr。**拿不到 `ChildProcess` 对象** |
| 发请求 | 给 | `net.fetch(url)` → 逐 URL 匹配 `hostPermissions` → `needsNetwork` 门 → `net.fetch`(Chromium 栈,受企业代理/证书)→ **response 剥成数据回传**,不传流句柄 |

### 5.5 活动审计

每次 facade 调用写一条环形缓冲记录(照抄 `src/main/hooks.ts:30-47` 的 `recentFailures`):

```ts
{ ts, pluginId, method, summary, verdict, durationMs }
```

插件详情页有一个"活动"标签直接展示。

---

## 6. 贡献点矩阵

图例:`现成` = 挂载点已存在;`薄改造` = 加一层注册表;`新建` = 全新机制。

### 6.1 Agent 侧

| 能力 | 落点 | 成本 |
|---|---|---|
| 贡献工具 | `kernel/tool/registry.ts:223` 的 `register()` | 薄改造:加 `ToolSource = {kind:'plugin',pluginId}` |
| 工具登记进注册表 | `runtime.ts:665-673` 的 `getTools()` + `kernel/tool/builtin/index.ts:29` 的硬编码数组 | 薄改造:数组改 provider 注册 |
| 工具拦截裁决 | `kernel/permission-decision.ts:80` 的 `decideAfterHooks` | 薄改造:与 `HookVerdict` 合并表决 |
| 计入工具桶估算 | `kernel/context-assembler.ts` 的 `estimateToolBuckets` | 薄改造:穷尽 switch 加分支 |
| 上下文注入 | `runtime.ts:2114-2119`(hook `additionalContext` 的同一条路) | 现成 |
| 贡献 Skill / Command / Agent / Mode | 四套扫描器加第三个根 | 薄改造 |
| 贡献 MCP server 配置 | `src/main/mcp/manager.ts` | 薄改造:必须先定全局还是工作区级 |
| 贡献主题 | `src/main/ipc/theme.ts:209` 的 `saveProfile` | 薄改造:绕开 `builtin-` 守卫,换插件命名空间 |

### 6.2 应用侧

| 能力 | 落点 | 成本 |
|---|---|---|
| **`+` 菜单项** | `shared/domain/tab.ts:135` + `shell/InnerTabBar.tsx:243` | 见 §7 |
| 自定义编辑器 | 无 | 新建(§3.6) |
| 视图(全页 / 侧边栏 / Dock 面板) | `stores/window.ts:45` 的 `activeStandaloneFeature` + `NAV_FEATURES`(`shell/Sidebar.tsx:43`)+ `views/registry.tsx` | 薄改造:4 张穷尽表改运行时注册表 |
| 命令 + 命令面板 | cmdk 已就绪(`shell/SearchPalette.tsx`),**无命令注册表** | 新建注册表;把 `SearchPalette` 降级为一个 provider |
| 快捷键 | `lib/accelerator.ts` 三件套现成 | 薄改造:`ShortcutSettings` 从 1 个字段扩成 `Record<string,string>`;`AppShell.tsx:201-209` 的孤立 keydown 升级为统一分发器 |
| 状态栏 | **完全不存在** | 新建。挂载点见 §7.5 |
| 设置项 | `settings/Row.tsx` 容器可复用,但**设置项今天不是数据** | 新建:JSON Schema 描述符 + 通用渲染器;持久化走独立 kv,**不扩 `AppSettings` blob** |
| 状态栏 / webview 视图 | 无 | 新建 |
| i18n | `i18n/index.tsx:3618` 是编译期封闭联合 | 见 §8 |

### 6.3 必须同时改的穷尽表(改了会编译报错,是好事)

| 位置 | 内容 |
|---|---|
| `shared/agent/tool.ts:20-23` | `ToolSource` 加 `plugin` |
| `kernel/tool/registry.ts:200-209` | `switch(s.kind)` 加分支 |
| `kernel/context-assembler.ts` | `estimateToolBuckets` 加分支 |
| `views/registry.tsx:169` | `INNER_VIEW_KINDS` 编译期哨兵 → 运行时注册表 **+ 等价测试** |
| `shell/icons.tsx:37,46` | `FEATURE_ICON` / `INNER_TAB_ICON` 的穷尽 Record → 查表函数 |
| `stores/tabs.ts:62` | `makeTab` 的 switch 加 `custom` 分支 |
| `shared/domain/dock.ts` | `migrateLegacyInnerTabs` / `normalizeDockState` 认得新 kind,否则落盘 Tab 重启后消失 |
| `stores/window.ts:276` | `NON_TAB_FEATURES` 过滤表的语义要重新表述 |

> ⚠️ `views/registry.tsx:168` 那句注释写着「加一种 kind 忘了写视图,这里编译期就挂」。替换成运行时注册表时**必须补一个等价的单元测试**,否则白白丢掉一层保障。

---

## 7. `+` 菜单改造与菜单贡献点

### 7.1 先修既有 bug:这个菜单现在没走 i18n

`shared/domain/tab.ts:135-141` 的 `INNER_TAB_MENU` 是**硬编码中文**;`shell/InnerTabBar.tsx:259` 直接 `{item.label}` 渲染,没有 `t()`。切到 `en-US` 这个菜单还是中文。同文件的 `FEATURE_LABEL`(`tab.ts:17`)同样。

这违反项目 AGENTS.md,而且插件贡献的菜单项不可能带裸文案进来 —— **所以这条 bug 与插件化合并做**。

### 7.2 现状的三个硬耦合

```tsx
// shell/InnerTabBar.tsx:243-260
{menu.map((item) => (
  <Fragment key={item.kind}>                              // ① kind 当身份
    {item.separatorBefore === true && <MenuSeparator />}
    <MenuItem
      icon={<INNER_TAB_ICON[item.kind] size={14}/>}       // ② kind 查穷尽 Record
      onSelect={() => { onOpen(item.kind); close() }}     // ③ kind 当动作
    >{item.label}</MenuItem>
```

`kind` 同时是身份、图标键、动作。插件项没有 `InnerTabKind`,三处全卡死。

另外 `shell/Dock.tsx:66` 是三条常量的三元选择:

```ts
const menu = edgePane === 'bottom' ? BOTTOM_TAB_MENU : edgePane === 'right' ? RIGHT_TAB_MENU : INNER_TAB_MENU
const open = (kind) => openDock(workspace.id, node.id, kind, undefined, edgePane)
```

> ⚠️ `shell/Panels.tsx:94,126` 也引用这两个常量,但**整个文件已是死代码**(全仓无 import)。改类型时它会报错 —— 要么删掉它,要么一起改。建议删(它同时让 `views/registry.tsx:83` 那句"`InnerView` 的两个调用方"的注释过期)。

### 7.3 新数据结构

```ts
// shared/domain/tab.ts —— 保持纯数据,可在 node 环境直测(同 settings/nav.ts:1-12 的理由)
export interface TabMenuItem {
  /** 稳定 id:内置 `builtin.chat`,插件 `excalidraw.new` */
  id: string
  /** ★ key 不是文案 —— 顺带修掉 §7.1 的 bug */
  titleKey: string
  /** lucide 名字白名单,不是 LucideIcon 组件(否则插件会把整个 lucide 打进 bundle) */
  icon: MenuIconName
  accelerator?: string
  /** 'view' | 'create' | 'tools' | `plugin:<pluginId>` */
  group: string
  order: number
  /** 在哪几格出现。省略 = 三格都出 */
  panes?: readonly TabPane[]
  action:
    | { kind: 'openTab'; tabKind: InnerTabKind }   // 内置
    | { kind: 'command'; commandId: string }        // 插件
}
```

内置菜单按 group 划分(分隔线由 **group 边界自动生成**,`separatorBefore` 字段删除):

| group | order | 内容 | 出现在 |
|---|---|---|---|
| `view` | 10 | 工作区文件、文件预览 | right / bottom |
| `create` | 20 | 新建对话、新建绘图、新建文档 | 全部 |
| `tools` | 30 | 新建终端、网页浏览 | 全部 |

截图里那条分隔(新建文档与新建终端之间)正好落在 `create|tools` 边界,**视觉零变化**。

### 7.4 渲染层合并

```ts
// src/renderer/src/shell/tab-menu.ts(新建)
export function useTabMenu(pane: TabPane): TabMenuItem[] {
  const contributed = usePluginStore((s) => s.menus['tabBar/new'])
  return useMemo(
    () => [...BUILTIN_TAB_MENU, ...contributed]
      .filter((i) => (i.panes ?? ALL_PANES).includes(pane))
      .sort(byGroupThenOrder),
    [pane, contributed]
  )
}
```

`Dock.tsx:66` 的三元 → `useTabMenu(edgePane)`;`InnerTabBar` 渲染改为 `t(item.titleKey)` + `item.action` 分发。

### 7.5 菜单 id 全表

| 菜单 id | 位置 | 需要的 context key |
|---|---|---|
| `tabBar/new` | 本计划的 `+` 按钮 | `pane` |
| `tabBar/context` | Tab 右键 | `tabKind`、`resourceExtname` |
| `explorer/context` | 文件树右键 | `resourceExtname` |
| `explorer/new` | 文件树新建 | — |
| `sidebar/nav` | 侧边栏(`shell/Sidebar.tsx:43`) | — |
| `chat/composer` | 输入框工具菜单 | — |
| `commandPalette` | 命令面板可见性(VS Code 同名) | `when` 表达式 |

涉及 `when` 的菜单需要一套最小 **context key** 子系统:一张扁平 `Record<string, string|boolean|number>` + 只支持 `==` `!=` `&&` `||` `!` `in` 的小求值器。**P1 只需支持 `pane`**;`explorer/context` 那一期再补齐求值器。

### 7.6 防插件挤爆菜单

1. 插件不能进内置 group 的前面 —— 即使写 `"group": "create@1"`,宿主也把它 clamp 到该 group 内置项之后。装 10 个插件也抢不走"新建对话"第一位。
2. 单插件在单个菜单**最多 3 项**,超出自动折叠成二级菜单(`DisplayName ▸`)。
3. 贡献菜单**不需要新权限**(点了只是执行插件自己的命令,能力门在命令实现里),但禁用插件时菜单项必须消失。

### 7.7 顺带修掉内置项的 i18n

`INNER_TAB_MENU` 的 5 个 label + `FEATURE_LABEL` 的 6 个 label 全部改成 `titleKey`,在 `src/renderer/src/i18n/index.tsx` 的 ZH 与 EN 各补对应 key。`makeTab`(`stores/tabs.ts:79-101`)里 `title: '新对话'` / `'未命名文档'` / `'未命名绘图'` 等默认标题同样是裸中文,一并改成 key(或在建 Tab 时由调用方用 `t()` 传 `init.title`)。

---

## 8. i18n 运行时注册(所有 UI 贡献点的前置依赖)

### 8.1 现状

```ts
// i18n/index.tsx:3618
export type TranslationKey = keyof typeof ZH;          // 编译期封闭联合
// i18n/index.tsx:3639
export function messagesFor(locale: Locale): Messages {
  return locale === "en-US" ? EN : ZH;                 // 模块级常量,无运行时注册入口
}
```

`t` 只做一次查表,**没有任何 `registerMessages` 入口**。插件文案在编译期不存在。

### 8.2 改造(改动面刻意压到最小)

```ts
// 1. key 类型开一个命名空间口子,内置 key 仍保持封闭
export type TranslationKey = keyof typeof ZH | `plugin.${string}`

// 2. 运行时 catalog 注册表(新建,与 index.tsx 同目录)
export function registerPluginMessages(
  pluginId: string, locale: Locale, dict: Record<string, string>
): void
export function unregisterPluginMessages(pluginId: string): void

// 3. messagesFor 签名不变,返回合并视图
export function messagesFor(locale: Locale): Messages {
  return { ...(locale === "en-US" ? EN : ZH), ...pluginMessages(locale) }
}
```

约束:

- 插件的 key **必须**是 `plugin.<pluginId>.<...>`,注册时强制前缀校验,冲突则整体拒绝。
- 包**必须同时**提供 `zh-CN` 与 `en-US`,缺一个就拒绝安装(市场侧也校验)。这是把 `i18n/index.test.ts:9-13`「en 必须覆盖 zh 每个 key」的保障延伸到插件。
- `interpolate()`(`:3624`)不动,缺 key 依然显示 key 本身而不崩。
- **插件显示名、命令 id、视图标题里的领域值不进 catalog**,沿用 `i18n/themes.ts:33`(用户主题名不过翻译表)的范式。
- `I18nProvider` 的 `t` 需要订阅注册表变更,否则装完插件要重启才生效。

### 8.3 主进程侧文案规则

本轮讨论中发现主进程存在**用户可见裸中文**,它们绕过 `src/renderer/src/i18n/`:

- `src/main/runtime.ts:481` — `name: '默认工作区'`(会进数据库、进 UI)
- `src/main/runtime.ts:1617` — `'排队中,等待空位'` / `` `排队中,前面还有 ${n} 个` ``(经 `tool_progress` 直接进界面)

本计划**新增的主进程代码一律只传 key**(如 `{ messageKey: 'plugin.activation.timeout', params: {...} }`),由渲染层 `t()` 渲染。既有那两处裸中文记为本计划的**可选清理项**,不阻塞主线。

---

## 9. webview 与视图外壳

### 9.1 受控 webview

- 加载自 `ncw-plugin://<pluginId>/views/x.html`,CSP 同 §4.3。
- 与插件逻辑之间用 `postMessage`,**不直连主进程**。
- 尺寸/位置/可见性由宿主决定,插件不能自己弹窗。
- 主题同步:宿主把 23 个 `--color-*` token(`shared/domain/theme.ts:42-66`)写成 webview `:root` 的行内样式;同时附带 `data-theme` / `data-theme-motion` 等属性(与 `theme/apply.ts:58-92` 写在 `<html>` 上的那套同名),插件 UI 自动跟随深浅色与动效偏好。

### 9.2 `PluginViewFrame`:外壳必须由宿主提供

`views/git/GitFeature.tsx:698-706`、`views/extensions/ExtensionsFeature.tsx:40-46` 等四个页面**各手写了一份**同一套 52px 标题栏 + `SidebarReveal` + `pr-window-controls`。

**先把它抽成组件,再开放给插件**,否则每个插件各写一份并各自漂移(`shell/SidebarReveal.tsx:10-16` 已经为同一个原因抽过一次)。该组件统一负责:

1. `.app-no-drag`(`styles/theme.css:424-434`)。`-webkit-app-region` 是继承属性,`shell/Dock.tsx:114-120` 记录过一次真实事故:给一栏挂 `app-no-drag` 导致滚动的长内容包围盒把整块 drag 区减掉。
2. z 轴固定在 0 档(`styles/theme.css:623-638` 只有 5 档),插件 UI 永远压不过宿主菜单/模态。
3. 懒加载边界。⚠️ `views/registry.tsx:8-33` 那段注释讲得很清楚:往这个表里加静态视图前必须把**传递依赖**跟到底(第一版就是 ScheduledFeature 静态 import ChatView,把 streamdown+katex 拽回主 bundle)。插件视图走运行时注册,必须 `React.lazy` + `Suspense`,且 fallback 用 `VIEW_FALLBACK` 那种同色空块(不要 spinner)。

**附带好处**:插件 UI 在 iframe 里,`components/ui/Menu.tsx:14-28` 那个"祖先链不能有 transform/filter"的陷阱天然够不着 —— 插件想弹菜单只能 `ncw.window.showQuickPick()`,由宿主渲染。

---

## 10. CoWork 后端:插件市场

### 10.1 决策:新建平行表,不动 skills

```sql
-- db/sql/migration_plugins_market.sql(新建)

plugins(
  id bigserial primary key,
  public_id uuid not null unique,
  author_user_id bigint not null,
  plugin_id text not null unique,       -- 'acme.excalidraw'
  slug text not null unique,
  publisher text not null,
  name text not null,
  display_name text not null,
  description text not null,
  long_description text,
  category text not null,
  icon_url text,
  status text not null default 'draft',  -- draft|pending|published|unlisted|rejected
  download_count bigint not null default 0,
  current_version_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

plugin_versions(
  id bigserial primary key,
  plugin_id bigint not null references plugins(id) on delete cascade,
  version text not null,
  changelog text,
  storage_path text not null,
  file_size bigint not null,
  sha256 text not null,
  status text not null default 'draft',
  manifest jsonb not null,              -- 整份 package.json
  permissions jsonb not null,           -- 从 manifest 提出,便于审核列表直接筛
  host_permissions jsonb not null,
  engines text not null,
  entry_file text not null,
  review_reason text,
  reviewed_by bigint,
  created_at timestamptz not null default now(),
  unique (plugin_id, version),
  unique (sha256)
);
```

配套:`db/README.md` 记录脚本顺序;`src/CoWork.Infrastructure/Data/DatabaseInitializer.cs` 的 `RequiredTables` 加两张表;`RepositoryRegistration.Generated.cs` 注册新仓储(该文件名含 Generated 但**实为人工维护**);SmokeTest 加 schema 断言。

> 严格按 AGENTS.md:结构变更要同时更新 `db/sql/migration.sql` 全量脚本、加增量脚本、更新 `db/README.md`、`RequiredTables` 与 SmokeTest。**不要**用循环按文件名批量执行 `db/sql/*.sql`。

### 10.2 端点

`src/CoWork.Api/Endpoints/PluginEndpoints.cs`(新建),`MapPluginEndpoints(this RouteGroupBuilder group, IConfiguration configuration)` 扩展,在 `Program.cs` 显式挂载。结构照抄 `SkillEndpoints.cs`:

| 端点 | 说明 |
|---|---|
| `GET /api/plugins` | 列表,q / category / sort / 分页;**新增 `client` 参数做 engines 过滤** |
| `GET /api/plugins/categories` | 分类 |
| `GET /api/plugins/{slug}` | 详情 + 已发布版本列表 |
| `GET /api/plugins/{slug}/versions/{version}` | 版本详情 |
| `GET /api/plugins/{slug}/versions/{version}/download` | ZIP 下载(Range 支持) |
| `GET /api/plugins/icons/{fileName}` | 图标(沿用 `^[a-f0-9]{32}\.(png\|jpg\|webp)$` 白名单) |
| `POST /api/client/plugins/{slug}/install` | **桌面端专用**:校验 OAuth scope,返回权威 `sha256` + `version` |
| `POST /api/plugins/validate` | 上传前校验(multipart) |
| `POST /api/plugins` / `PATCH /api/plugins/{id}` | 作者建/改 |
| `POST /api/plugins/{id}/versions` | 上传版本 |
| `POST /api/plugins/{id}/submit` | 提交审核 |
| `GET /api/plugins/mine` | 我的插件 |
| `POST /api/plugins/{id}/unlist` | 下架 |
| `GET /api/admin/plugins/pending` | 审核队列 |
| `GET /api/admin/plugins/versions/{versionId}` | 审核详情 |
| `POST /api/admin/plugins/versions/{versionId}/review` | 通过/驳回 |

四处必须与 Skills 版不同:

1. **ZIP 校验规则换掉**。`SkillEndpoints.cs:220-255` 的 `ValidateZip` 处理得很好(路径穿越、符号链接、单顶层目录、解压炸弹、深度上限、重复路径),**那几条原样保留**;把"必须有 `SKILL.md` 且 frontmatter name 与顶层目录一致"换成:
   - 必须有一个顶层目录,且等于 `<publisher>.<name>`
   - 必须有 `package.json`,且过 §2.2 的字段校验
   - 必须有 `main` 指向的文件,且存在
   - `l10n/` 必须同时有 `zh-CN.json` 与 `en-US.json`
   - `contributes.*.title` 必须全是 `%key%` 形式
   - 所有 `contributes.*.path` 必须指向包内存在的文件
2. **能力差异审查**。新版本的 `permissions` 是上一已发布版本的严格超集时,`plugin_versions` 记 `permission_escalated boolean`,审核页标红,DTO 带 `permissionEscalated: true`,客户端据此强制重新弹批准框。
3. **engines 过滤**。`GET /api/plugins?client=0.2.3` 只返回与该版本兼容的插件;客户端"检查更新"也带上该参数,避免推一个装不上的版本。
4. **OAuth scope**。在 `src/main/ipc/client-auth.ts:444` 那一行的 scope 串里加 `plugins:read plugins:install`;后端 `ClientOAuth` 侧同步。

### 10.3 客户端安装流程

**原样复用** `src/main/ipc/skills.ts:171-202` 的四步:

1. `POST /api/client/plugins/{slug}/install` 拿授权 + 权威 `sha256` + `version`
2. 校验返回的 version 与请求一致、sha256 形如 64 位 hex
3. `GET .../versions/{version}/download` 下载,`readDownload` 的 20MB 上限沿用
4. `installer` 校验 sha256 → 解压 → 写入 `<userData>/plugins/<id>/`

建议把这段抽成 `installMarketPackage(kind, ...)`,与 Skill 共用。ZIP 解压层面的防线复用 `kernel/skill/install.ts:14-18,37-48,106-118,145-193`(体积/条目数/展开体积/深度上限、拒绝符号链接、staging + backup + 失败回滚)。

---

## 11. 交付路线

| 期 | 内容 | 完成标志 |
|---|---|---|
| **P0 还债** | ① i18n 运行时注册(§8)② `skill/agent/mode` 三个注册表加 workspace 分桶 ③ `builtinTools()` 改 provider 注册 ④ `.next-cowork` 常量合并 ⑤ 抽 `PluginViewFrame` 外壳 ⑥ 删除死代码 `shell/Panels.tsx` | `npm run typecheck` / `npm run lint` / `npm test` 全绿,**无用户可见变化** |
| **P1 宿主骨架** | `ncw-plugin://` 协议 + 宿主窗口 + MessagePort RPC + `package.json` 解析校验 + 能力批准 UI + 本地目录/ZIP 安装 + 启用/禁用/卸载 + 诊断面板 + `+` 菜单改造成 `contributes.menus`(含 §7.1 的 i18n bug 修复) | 能装一个只 `console.log` 的 hello 插件,菜单里出现它的一项,禁用后消失 |
| **P2 Agent 能力** | `ToolSource` 加 plugin、`plugin/tools.ts` 桥接、`plugin/interceptor.ts` 接进 `decideAfterHooks`、`agent.registerContextProvider`、`ncw.workspace.fs` / `process` / `net` 三个受控能力 + 审计日志 | 插件能贡献真工具并在权限链里露头;Excalidraw 的 `read_diagram`/`edit_diagram` 可跑 |
| **P3 UI 贡献** | `customEditors`(含 untitled 文档)、`PluginViewFrame` 开放、视图/面板贡献、命令注册表 + 命令面板、快捷键、状态栏、设置项 JSON Schema 渲染器、主题贡献 | Excalidraw 能在 Tab 里打开 `.excalidraw`、画、保存、脏状态挽留 |
| **P4 市场闭环** | CoWork 侧表 + 端点 + 审核台 + OAuth scope;客户端市场页(照抄 `views/extensions/ExtensionsFeature.tsx` 的 `Segmented` 结构,落在 `views/extensions/` 内加一个 Tab);更新检查 | 用户能自己打包并上传,再从设置里的「连接 › 插件」页搜到并安装 |
| **P5 工具链** | `create-nextcowork-plugin` 脚手架 + `@aidotnet/plugin-api` 发布 + `plugin-cli` 打包/发布 + `dev --watch` 本地调试 | **只读公开文档的新作者能在 30 分钟内跑通 hello world** |

**P0 与 P1 可以并行开工**(不同文件域),P2 依赖 P1,P3 依赖 P0 的 i18n,P4 依赖 P1 的安装流程。

### 11.1 每期的验证

- **P0**:`npm run typecheck && npm run lint && npm test`。三个注册表的分桶要有新增单测(两个工作区并发装配,断言互不串味)。
- **P1**:手工装一个 fixture 插件(`src/main/plugin/__tests__/fixtures/`);RPC 层单测(白名单拒绝、能力拒绝、超时、崩溃后 `unregisterBySource` 的时序)。
- **P2**:`kernel/tool/registry.ts` 的 `source` 分支单测;`decideAfterHooks` 合并表决的真值表单测(deny 优先、ask 传播、超时弃权)。
- **P3**:`PluginViewFrame` 的 `.app-no-drag` 走 `npm run e2e`(已有 `scripts/e2e-probe.mjs`);`INNER_VIEW_KINDS` 哨兵被替换后补的等价测试;**主 bundle 体积回归**——新增注册表不得把 codemirror/xterm/streamdown 拽回主 bundle,用 `npm run build` 的输出对比 `views/registry.tsx:8-33` 记的那三坨体积。
- **P4**:后端 `dotnet build CoWork.slnx --configuration Release --no-restore`、`dotnet run --project tests/CoWork.AuthTests`、SmokeTest 加 `plugins`/`plugin_versions` 的 schema 断言;前端 `(cd web && npm run lint && npm run build)`。按 AGENTS.md,CoWork 没有 `dotnet test`、没有独立 typecheck 脚本,不要声称跑过不存在的命令。
- **P5**:端到端 —— 在一台干净的机器上(或 `--user-data-dir` 隔离的新数据根,见 `src/main/index.ts:66-68`)走完整流程:装脚手架 → 写 hello → 打包 → 上传 → 审核 → 安装 → 启用。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **每插件一个 renderer 进程** | 装 10 个插件内存爆 | `activationEvents` 强制懒激活 + 空闲 5 分钟休眠 + `onStartup` 市场审核默认驳回 |
| **`engines` 与 API 演进** | VS Code 背了十年兼容包袱 | 明确宣告 1.0 之前 API 可 break;`manifestVersion` 与 `engines` 从第一版就卡死 |
| **RPC 往返延迟** | 工具调用变慢 | 工具调用本就是百毫秒量级,可忽略;但**必须**做中断的一刀两断语义(§4.5) |
| **`connect-src` 阻断** | Excalidraw 素材库、CDN 字体不可用 | 由插件层桥接到 `ncw.net.fetch`;字体资源必须打进包内(`window.EXCALIDRAW_ASSET_PATH` 指向 `ncw-plugin://<id>/dist/`) |
| **iframe 需要 `allow-same-origin`** | 安全评审会质疑 | 记录理由:opaque origin 会让 `localStorage`/`IndexedDB` 抛异常;安全性来自 origin 差异而非 sandbox 属性 |
| **大体积 webview** | 首屏卡顿 | 只在该插件视图可见时加载 iframe;`onCustomEditor` 懒激活 |
| **Agent 与编辑器并发改同一文件** | 用户改动被 Agent 覆盖 | 写盘带 `revision` 乐观锁 + 订阅 `workspace.onDidChangeFiles` + 外部变更提示(§3.6) |
| **i18n key 类型从封闭联合退让** | 失去编译期拼写检查 | 只开 `plugin.${string}` 一个口子,内置 key 仍封闭;`i18n/index.test.ts` 扩成"插件两套 locale 必须齐" |
| **菜单被插件挤爆** | 核心动作被顶掉 | §7.6 的三条硬规则 |
| **`contributes.customEditors` 与落盘 Tab** | 重启后插件 Tab 消失 | `shared/domain/dock.ts` 的 `migrateLegacyInnerTabs` / `normalizeDockState` 必须认得 `kind: 'custom'`,且插件被卸载时优雅降级为只读文本预览 |

### 12.1 被推迟的 API:必须有可理解的降级提示

`process.createTerminal`、`contributes.chatRenderers`、插件的自动更新——本计划不做,但**必须在插件运行期给出可理解的失败**,而不是静默不生效:

- `ncw.process.createTerminal` 第一版**不出现**在 `nextcowork.d.ts` 里(编译期就挡住,比运行期报"未实现"好)。
- 插件的聊天内嵌渲染、调试适配器类贡献点若出现在 `contributes` 里,装载时报一条 **diagnostic**(照 `kernel/skill/load.ts:69-75` 的"永不 throw、一切失败变 diagnostics"),显示在插件详情页,而不是让插件作者对着"没有反应"发呆。
- 新增 `src/main/plugin/unsupported.ts` 集中维护这份"已知未实现的贡献点"清单,随版本收缩。

---

## 13. 验证总表

### 13.1 命令(都来自各仓库真实脚本,不要臆造)

NextCoWork(`package.json:11-31`):

```bash
npm run typecheck      # typecheck:node + typecheck:web
npm run lint
npm test               # vitest run
npm run build          # typecheck && electron-vite build
npm run e2e            # npm run build && node scripts/e2e-probe.mjs
npm run dist:dir       # 打包目录,用于验证插件目录在真实安装形态下可写
```

CoWork(按仓库 AGENTS.md):

```bash
dotnet build CoWork.slnx --configuration Release --no-restore
dotnet run --project tests/CoWork.AuthTests
dotnet run --project tests/CoWork.SmokeTest -- "<隔离的 PostgreSQL 连接串>"
(cd web && npm run lint && npm run build)
```

> CoWork **没有** `dotnet test`、没有 `--filter`、没有后端 lint/format 命令。三个 .NET 测试项目都是 `Program.cs` 顺序执行 `Check(...)` 的控制台程序,最小可运行粒度是整个项目。

### 13.2 数据隔离

手工验证插件安装/卸载时**必须**用隔离数据根,避免污染真实 `~/.next-cowork`:

```bash
npm run dev -- --user-data-dir=/tmp/ncw-plugin-test
```

该开关在 `src/main/index.ts:66-68` 已被识别,`scripts/` 下的探针靠它做隔离。

### 13.3 逐项验收清单

- [ ] `npm run typecheck && npm run lint && npm test` 全绿
- [ ] 切换语言到 `en-US`,`+` 菜单与 `FEATURE_LABEL` 全部变英文(§7.1 的 bug 已修)
- [ ] 两个工作区并发 run 时,Skill/Agent/Mode 的提示词内容不互相覆盖(P0 分桶)
- [ ] 主 bundle 体积不因新增注册表而增长(对比 `views/registry.tsx:8-33` 记的那三坨)
- [ ] 安装 fixture 插件后:菜单出现、工具出现在工具清单、禁用后两者都消失、数据目录无残留
- [ ] 未声明的 API 调用被拒(白名单 + 能力双层),错误进诊断面板
- [ ] 升级到扩大 `permissions` 的版本时,插件进入待批准状态且不激活
- [ ] Excalidraw 插件:打开 `.excalidraw` → 画 → 保存 → 关 Tab 有挽留 → Agent 用 `read_diagram`/`edit_diagram` 读写同一张图 → Agent 改盘上文件时编辑器提示外部变更
- [ ] CoWork:`dotnet run --project tests/CoWork.SmokeTest` 断言到 `plugins` / `plugin_versions`
- [ ] 全流程:脚手架的 hello 插件从零到上架,不走任何内置路径

---

## 14. 待确认事项

以下四项不阻塞 P0/P1 开工,但**在对应期次开始前必须定**:

1. **untitled 文档**(P3 前定)。截图里的「新建绘图」现在是 `path: ''` 的空 Tab(`stores/tabs.ts:85`),即 untitled 在类型上有、实现上没有。方案 A:先弹保存对话框再开编辑器(简单,与现有「新建文档」行为一致);方案 B:真做 `Uri.untitled(...)`,首次保存才落盘(更对,但需要 `saveCustomDocumentAs` + untitled scheme 一起做,且 `doc`/`draw` 两种内置 kind 同样受益)。**倾向 B。**
2. **插件贡献的 MCP server 走全局还是工作区级**(P2 前定)。`runtime.ts:682` 与 `:695` 是两套不同的生命周期(全局复用 `getTools()` 的 registry;工作区级每工作区一套 registry + manager)。选错会导致"插件启用后 MCP 连不上但诊断不报错"。
3. **`@aidotnet/plugin-api` 是否公开发布到 npm**(P5 前定)。公开则生态友好(`npm i -D` 即可),但 API 对外承诺;不公开则只能从市场下 d.ts。
4. **`agent.registerContextProvider` 的注入上限**(P2 前定具体数值)。建议:单次注入 ≤ 2000 字符,每轮总注入 ≤ 8000 字符,超出截断并在 UI 上标注。
