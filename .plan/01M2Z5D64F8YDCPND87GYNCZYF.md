# 插件体系能力扩展计划

按**分层**组织（协议层 → 宿主层 → 渲染层 → 文档与示例），不按功能分期。
每一层内部按「文件 → 改什么 → 为什么 → 失败时什么表现」写。

---

## 0. 现状事实（逐条在代码中验证过，不是推测）

### 0.1 已宣称但**完全走不通**的 API

| API | 声明处 | 为什么走不通 |
|---|---|---|
| `env.openExternal` | `shared/plugin/protocol.ts:38`、`packages/plugin-api/nextcowork.d.ts:55`、垫片 `main/plugin/protocol.ts:228` | `manager.ts:896` 的 `handleHostMethod` 与 `rpc.ts:97` 的 `invokeCapability` **都没有 case** → 落到 `rpc.ts:265` 抛 `internal_error: method env.openExternal has no handler` |
| `env.clipboardRead` / `env.clipboardWrite` | 同上（`protocol.ts:39-40`） | 同上 |
| `window.showQuickPick` | `protocol.ts:87`、垫片 `main/plugin/protocol.ts:269` | 同上 |
| `scm.status` | `protocol.ts:83`，权限 `scm.read` | 同上。`scm.write` 权限在枚举里（`permission.ts:43`）但**零方法** |
| `configuration.get` | 宿主已实现（`manager.ts:1065`）、d.ts 已声明（`nextcowork.d.ts:168`） | 生成的垫片 `runtimeJs()` **没有 `export const configuration`** → 插件侧 `ncw.configuration is undefined` |
| `customEditors.setDirty` | 宿主已实现（`manager.ts:1039`），`plugins:confirmClose` 也接好了 | 垫片没有 `customEditors` 命名空间 → 脏标记**永远为空**，关 Tab 不拦 |
| `agent.registerInterceptor` / `registerContextProvider` | 宿主完整实现且有测试（`manager.ts:982/986`、`__tests__/agent-bridge.test.ts`） | 垫片没有 `agent` 命名空间 → 两条能力（`agent.intercept`/`agent.context`）**没有任何插件能用** |
| `ncw:doc:dirty` | `renderer/src/shell/PluginViewFrame.tsx:62` 在 `DocumentMessage` 里声明 | 消息处理只有 `ncw:doc:ready` / `ncw:doc:save` 两个分支，dirty 被静默丢弃 |

### 0.2 ★★ engines 判定是错的 —— 所有按官方脚手架生成的插件都是红的

- `manager.ts:335` 拿 `satisfiesEngine(manifest.engines, this.deps.hostVersion)` 判定；
- `hostVersion` 来自 `ipc/plugins.ts:72` 的 `app.getVersion()` = **应用版本**，当前 `package.json:3` 是 `2.2.2`；
- 脚手架默认写的是 `engines.nextcowork: "^0.2.0"`（`packages/create-nextcowork-plugin/index.mjs:37`），Skill 文档里也是这个值；
- `satisfiesEngine('^0.2.0', '2.2.2')` → `version.major === 0` 分支 → 要求 `host.major === 0` → **false** → `status: 'error'`，诊断写「requires ^0.2.0, this host is 2.2.2」。

也就是说：**今天用官方脚手架生成、按官方文档写的插件，装上就是「装载失败」**。这不是边角问题，它让本计划的其余部分全部不可验收，所以排在第一位。

### 0.3 解析了但**没人消费**的贡献点

- `contributes.views`：全仓唯一读它的地方是 `views/plugins/CustomEditorView.tsx:64`，取 `views[0]` 当自定义编辑器的 UI 文件。**没有侧栏/Tab 挂载点**，因此 `onView:<id>` 激活事件永不触发。
- **7 个菜单挂载点只实现了 1 个**：`shell/tab-menu.ts:26` 消费 `tabBar/new`；`tabBar/context`、`explorer/context`、`explorer/new`、`sidebar/nav`、`chat/composer`、`commandPalette` 均在 `shared/plugin/contribution.ts:45` 的 `MENU_IDS` 里被接受，然后静默不生效。
- `contributes.themes` / `contributes.skills`：`main/plugin/installer.ts:271-282` 只校验文件存在，**从不加载**。
- 没有任何「插件打开网页」的通路：应用内浏览器本身很完整（`shared/domain/browser.ts`、`InnerTab` 的 `kind:'browser'`（`shared/domain/tab.ts:105`）、每工作区 session 分区 `browserPartition()`、`views/browser/BrowserView.tsx` 的 `<webview>`），但插件侧一条 RPC 都没有；连 `env.openExternal`（系统浏览器）都如 §0.1 所述是死的。
- 清单**强制 `main` 为单文件 ESM**（`manifest.ts:257-260`）→ 「只想包一个网站」的插件今天也必须写 JS、打包、起一个隐藏 BrowserWindow。

### 0.4 已经能用、本计划**不得破坏**的部分

commands + keybindings（`shell/useCommandShortcuts.ts` 真正分发）、tools 三层卡片（结果卡/实时卡/交互卡）、customEditors（`shared/plugin/custom-editor.ts` 的 `pickCustomEditor` 分派）、插件间通信（`plugins.expose/invoke/events`）、市场/更新/权限升级闸（`pending-approval`）、四道门 RPC、`ncw-plugin://` 协议与视图垫片。

---

## 1. 目标与非目标

**目标**

1. 让「插件 = 打开哔哩哔哩」这类**零代码网页包装**成立：装上即多一个入口，点开在应用内浏览器里，复用当前工作区的登录态。
2. 把已宣称的 API 全部接通；不能接通的从 d.ts / Skill 里**删掉**（诚实优先于看起来能力多）。
3. 把解析了却没人消费的贡献点全部落地：views 有挂载位、7 个菜单挂载点全通、themes / skills 真正加载。
4. 扩展能力面：Git 全套、工作区事件订阅、窗口交互 API、卡片原语、Agent 集成（斜杠命令 / 拦截器 / 输入框按钮 / 贡献 Agent 与 Mode）、命令执行增强。
5. 插件 API 版本与应用版本解耦，并给出老插件的迁移路径。

**非目标**（写进文档，避免下一个人以为漏了）

- 不做交互式终端贡献点（`unsupported.ts:47` 已写明理由：输入过不了审批链）。
- 不做调试适配器、notebooks、languages（`unsupported.ts` 现有条目保持）。
- 不做真正的文件系统 watcher（理由见 §4.5），工作区事件只覆盖**经由应用发生的变更**。
- 不动插件市场服务端协议。

---

## 2. 三个全局决策（后面所有改动都依赖它们）

### D1：插件 API 版本与应用版本解耦

新增 `shared/plugin/api-version.ts`，导出 `PLUGIN_API_VERSION = '0.3.0'`。`manager.ts:335` 改成拿它判定，而不是 `app.getVersion()`。

- `PluginCatalog` 增加 `apiVersion: string`，`hostVersion` **保持应用版本不变**（`ipc/plugin-market.ts:52` 用它当市场的 `client` 参数，改了会影响服务端筛选）。
- 迁移：`engineCompatibility(range, apiVersion)` 返回 `'ok' | 'deprecated' | 'incompatible'`。`^0.2.0` 在 0.3.0 下按 semver 是 incompatible，但那批插件**在今天的宿主上本来就是 error**，它们从未真正跑起来过；所以这里给一条显式兼容：range 落在 `LEGACY_API_RANGES = ['^0.2.0', '~0.2.0', '0.2.0', '>=0.2.0']` 时判 `'deprecated'` —— **照常装载运行**，但在 `diagnostics` 里推一条 warn：「这份清单声明的是 0.2 的 API，请改为 `^0.3.0`」。
- 这条兼容是**有拆除条件的临时方案**：注释里写明「当市场上 0.2 声明的包降到 0 时删掉 `LEGACY_API_RANGES`」，不写条件的 TODO 等于永久债务。
- 备选（写进文档不采纳）：把 `hostVersion` 直接换成 API 版本 —— 会让市场请求的 `client` 参数变成 0.3.0，服务端按应用版本做的灰度会全部错位。

### D2：`kind: "webapp"` —— 第二条装载路径，而不是「main 可选」

清单新增 `kind?: 'extension' | 'webapp'`（缺省 `extension`，老清单零改动）。

- `webapp` 的校验规则：**不要求 `main`**（写了就报错，不是忽略 —— 忽略会让作者以为他的代码在跑）；必须有至少一条 `contributes.webApps`；不允许 `contributes.tools` / `commands` / `customEditors`（没有代码就没有处理函数，声明了必然是静默失败）。
- 运行期：webapp 插件**永不 spawn 宿主窗口**，状态在 `idle` / `disabled` / `error` 之间，不会是 `active`。内存开销为零。
- 为什么不选「`main` 变可选」：那样 `activate()` 的存在与否变成一件要在五个地方各判断一次的事（激活、休眠、`runCommand`、`contributedTools`、`shutdown`），而 `kind` 让它在**装载那一刻**就分流，后面每一处都是一次 `if (record.kind === 'webapp') continue`。

### D3：网页 URL 门 = 新权限 `tabs.browser` + 复用 `hostPermissions`

- 新增能力 `tabs.browser`（`PLUGIN_PERMISSIONS` 末尾追加，顺序即授权弹窗顺序，见 `permission.ts:169`）。
- URL 门复用 `matchesHostPermission()`（`manifest.ts:690`）：**仅 https、逐 URL 匹配 `hostPermissions`、拒内网/环回**（`capabilities.ts:130` 的 `isPrivateHost`）。与 `net.fetch` 同一张白名单、同一个判定函数 —— 两张表会分叉，一张不会。
- 声明式的 `contributes.webApps[].url` 在**装载时**就过同一道门（不合法 → 诊断 + 该条目不生效），运行期打开它不再逐次判权限：URL 已经写死在用户安装时看得见的清单里了。动态 `tabs.openBrowser(url)` 需要 `tabs.browser` 权限**且** URL 命中 `hostPermissions`。
- 登录态：复用工作区 profile（`browserPartition(workspaceId, profileId)`），与用户自己开的浏览器 Tab 同一分区 —— B 站已登录就直接可用。**这一条要在插件详情页的能力说明里写清楚**：「该插件打开的网页与你的浏览器标签共享登录状态」。

---

## 3. L0 协议层（`src/shared/**`，纯数据 + 纯函数，可直测）

### 3.1 新文件 `shared/plugin/api-version.ts`

```
PLUGIN_API_VERSION = '0.3.0'
LEGACY_API_RANGES: readonly string[]
engineCompatibility(range: string, apiVersion: string): 'ok' | 'deprecated' | 'incompatible'
```

文件头注释写清 D1 的全部理由与拆除条件。`satisfiesEngine` 留在 `manifest.ts` 不动（它是纯语义函数，被 range 解析共用）。

### 3.2 `shared/plugin/manifest.ts`

新增字段与贡献点（全部可选，老清单解析结果不变）：

| 字段 | 形状 | 校验 |
|---|---|---|
| `kind` | `'extension' \| 'webapp'` | 缺省 extension；webapp 见 D2 |
| `contributes.webApps[]` | `{ id, title: %key%, icon?, url, open?: 'tab' \| 'feature' \| 'right', entry?: 'sidebar' \| 'none' }` | id 同 `PLUGIN_NAME_RE` 形状；title 必须 `%key%`；url 过 `isHostPattern` 同源判定 + https；`open` 缺省 `'tab'`；`entry` 缺省 `'sidebar'` |
| `contributes.views[].location` | `'editor' \| 'sidebar' \| 'panel'` | 缺省 `'editor'`（= 今天的行为：给 customEditor 当 UI），**不改变老插件** |
| `contributes.slashCommands[]` | `{ name, command, title: %key%, description?: %key% }` | `command` 必须在 `contributes.commands` 里；`name` 只允许 `[a-z0-9-]{1,32}`（它会出现在输入框里） |
| `contributes.agents[]` / `contributes.modes[]` | `{ path }` | 同 `skills`：包内相对路径 |

`ACTIVATION_EVENT_PREFIXES` 增加 `onWebApp:`、`onSlashCommand:`。

`MAX_CONTRIBUTIONS_PER_KIND` 对新数组同样生效。所有新解析分支照现有写法：**读不懂 → 推 `errors` 整份拒绝**（装载期严格），认不出的键 → `unsupported`（`manifest.ts:424`）。

### 3.3 `shared/plugin/permission.ts`

- `PLUGIN_PERMISSIONS` 追加 `'tabs.browser'`（放在 `clipboard` 之后、`plugins` 之前，让「界面类」能力聚在一起）。
- `isMutatingPermission` **不包含** `tabs.browser`（打开网页不改文件、不跑命令，不该进审批链）。
- `scm.write` 已在枚举里，本计划第一次给它方法（§3.4）。

### 3.4 `shared/plugin/protocol.ts` —— 方法表扩充

全部按现有规矩：`PluginMethodMap` 加一条 + `PLUGIN_METHOD_PERMISSION` 加一条（`satisfies Record<PluginMethod, ...>` 会在漏写时编译报错）。

**Tabs / 网页**

```
'tabs.openWebApp'  { webAppId }                  → { opened }   权限 null（清单已写死 URL）
'tabs.openBrowser' { url, open?, reuse? }        → { opened }   权限 'tabs.browser'
'tabs.openView'    { viewId, location? }         → { opened }   权限 null（viewId 必须自己声明过）
```

**SCM（读 `scm.read` / 写 `scm.write`）**

```
'scm.status'    （已存在，本次才有实现）
'scm.diff'      { path?, staged? }               → { diff }
'scm.log'       { limit?, path? }                → { commits: [{ hash, subject, author, at }] }
'scm.branches'  {}                               → { current, branches }
'scm.stage'     { paths }                        → {}            'scm.write'
'scm.commit'    { message }                      → { hash }      'scm.write'
'scm.createBranch' { name, from? }                → {}            'scm.write'
'scm.checkout'  { name }                          → {}            'scm.write'
```

写类一律经既有审批链（`isMutatingPermission` 已覆盖 `scm.write`）。**不开 push/pull**：它们会把本机凭据用到远端，且失败形态（冲突、鉴权、hook）不是一条 RPC 能如实回答的。

**工作区事件**

```
'workspace.subscribeChanges'   { globs? }         → {}   'workspace.read'
'workspace.unsubscribeChanges' {}                 → {}   'workspace.read'
```

反向通道复用 `PluginInvocation` 的 `kind: 'event'`，payload `{ event: 'workspace.changed', changes: [{ path, kind: 'created'|'modified'|'deleted' }] }`。

**窗口 / 交互**

```
'window.showQuickPick'  （已存在，本次才有实现）
'window.showInputBox'   { titleKey, placeholderKey?, initial?, password? } → { value: string | null }   权限 null
'window.showConfirm'    { titleKey, detailKey?, danger? }                  → { confirmed }              权限 null
'window.progressStart'  { id, titleKey }                                   → {}                          权限 null
'window.progressUpdate' { id, fraction?, messageKey? }                     → {}
'window.progressEnd'    { id }                                             → {}
```

限流与配额同 `window.setStatusBarItem`（`manager.ts:990`）：单插件同时最多 1 个输入框、1 个确认框、3 条进度；`*Key` 一律是 l10n key，不是文案。

**命令执行增强**

```
'process.execStream'  { command, args, cwd?, timeoutMs? } → { execId }   'process'
'process.execAbort'   { execId }                          → {}
```

输出经 `kind: 'event'` 推 `{ event: 'process.output', execId, stream: 'stdout'|'stderr', chunk }`，结束推 `{ event: 'process.exit', execId, code }`。**审批在 start 时问一次**（同 `rpc.ts:192`），不逐 chunk 问；单次输出总量上限沿用 `MAX_PLUGIN_FILE_BYTES`，超了截断并推一条 `truncated: true`。

**Agent 集成**（方法已存在，本次补垫片；新增一条）

```
'agent.registerSlashCommand' { name } → {}   权限 null（name 必须在 contributes.slashCommands 里）
```

### 3.5 `shared/agent/tool-card.ts` —— 卡片原语扩展

在 `CardBlock` 联合里新增，并在 `sanitizeBlock`（`tool-card.ts:77`）里各加一个 case：

- `{ type: 'markdown'; value: string }` —— 渲染层走**已有的受信 markdown 渲染器**（`components/markdown/**`，链接照 `link` 块的规矩路由到 openExternal），不允许裸 HTML。
- `{ type: 'list'; items: Array<{ label: string; tone?: CardTone; hint?: string }> }`
- `{ type: 'metric'; label: string; value: string; delta?: string; tone?: CardTone }`
- `{ type: 'divider' }`
- `button` 增加可选 `confirm?: { titleKey: string }` —— 危险动作点下去先确认。

`MAX_CARD_BYTES` / `MAX_BLOCKS` 不变（16KB / 32 块）：新原语不是为了塞更多数据，是为了**少一点** JSON 转储。未知 type 仍然返回 `null`（前向兼容规则不动）。

### 3.6 `shared/plugin/contribution.ts`

- `MENU_ICON_NAMES` 增加 webapp 场景要用的几个：`tv`、`music`、`video`、`book`、`mail`、`calendar`、`users`、`home`（渲染层 `Record<MenuIconName, LucideIcon>` 必须同步加，否则回落 `puzzle`）。
- `MENU_GROUPS` 不变；`mergeMenuItems` 的 clamp 规则不变（插件永远排在内置之后）。
- 新增 `WhenContext` 的标准键名常量表（`hasWorkspace`、`resourceExtname`、`resourceScheme`、`tabKind`、`isDirty`…），三处菜单调用点共用一份 —— 现在 `when` 的可用变量**没有任何地方定义过**，作者只能猜。

### 3.7 `shared/ipc/contract.ts`（主窗口通道，与插件 RPC 是两条路）

新增请求：

```
'plugins:openWebApp'    { pluginId, webAppId }                  → void      // 渲染层点侧边栏入口时回问主进程要 URL + 激活事件
'plugins:runSlashCommand' { pluginId, name, args? }             → void
'plugins:interactionReply' { requestId, value }                 → void      // showInputBox / showConfirm / showQuickPick 的回执
```

新增广播：

```
'plugins:openTab'      { pluginId, target: {kind:'webapp'|'view'|'browser', ...}, open: 'tab'|'feature'|'right' }
'plugins:interaction'  { requestId, pluginId, kind: 'quickPick'|'input'|'confirm', payload }
'plugins:progress'     { pluginId, id, titleKey, fraction?, messageKey?, done? }
```

每条都要在三张白名单里登记（`contract.ts` 末尾的计数表）。

---

## 4. L1 宿主层（`src/main/**`）

### 4.1 补齐死 handler + 垫片导出（对应 §0.1，**最高优先级**）

`main/plugin/rpc.ts` 的 `invokeCapability` 增加 case：

- `env.openExternal`：URL 过 `narrowFetchUrl` 之外的一条**独立**判定（允许 `https:` 与 `http:`？→ **只允许 https**，与 `capabilities.ts` 的立场一致），再调注入进来的 `openExternal`（**注入，不在 rpc.ts 里 import electron** —— 该文件现在只依赖 `KernelHost`，见 `rpc.ts:56` 的注释）。
- `env.clipboardRead` / `env.clipboardWrite`：同样注入 `clipboard` 能力；读做一次性确认（`permission.ts:48` 的说明要求）。
- `scm.*`：注入一个 `scm` 适配器，内部复用 `main/ipc/git.ts` 的既有函数（`getGitOverview` / `getGitDiff` / `listGitCommits` / `listGitBranches` / `stageGitPaths` / `commitGit` / `createGitBranch` / `checkoutGitBranch`），workspaceId 取 `CapabilityContext.workspaceId`。

`main/plugin/manager.ts` 的 `handleHostMethod` 增加 case：`window.showQuickPick`、`window.showInputBox`、`window.showConfirm`、`window.progress*`、`tabs.openWebApp`、`tabs.openBrowser`、`tabs.openView`、`workspace.subscribeChanges/unsubscribe`、`agent.registerSlashCommand`、`process.execStream/execAbort`。

`main/plugin/protocol.ts` 的 `runtimeJs()` 垫片增加导出：`configuration`、`customEditors`、`agent`、`scm`、`tabs.openWebApp/openBrowser/openView`、`window.showInputBox/showConfirm/withProgress`、`workspace.onDidChangeFiles`、`process.execStream`。
★ 垫片里 `agent` 的两个注册函数要把处理函数存进 `handlers`，并在 `__bootstrap` 的 `onInvoke` 里补 `interceptor.willInvoke` / `interceptor.didInvoke` / `context.provide` 三个分支 —— 主进程侧早就会发这三种 invocation（`manager.ts:1268/1300`），而垫片当前会落到最后一行 `throw new Error('unsupported invocation')`。

**验收锚点**：一个只写 `ncw.env.openExternal('https://www.bilibili.com')` 的插件，点一下能在系统浏览器里打开 B 站。今天这一行抛 `internal_error`。

### 4.2 webapp 装载路径（D2）

`main/plugin/manager.ts`：

- `PluginRecord` 增加 `kind`；`load()` 里按 `manifest.kind` 分流。
- `wake()` 对 webapp **直接返回**（不 spawn、不 activate、不计入休眠扫描）。
- `contributedTools()` / `runCommand()` / `intercept()` / `provideContext()` 对 webapp 早返回。
- `setEnabled(false)` 时清 statusBar / 菜单项的既有逻辑对 webapp 同样生效（它有贡献项，只是没有代码）。

`main/plugin/installer.ts`：`validateContributionFiles`（`installer.ts:271` 一带）对 webapp 跳过 `main` 存在性校验，改为校验 `webApps[].url` 合法 + icon 存在。

### 4.3 打开网页 / 视图的转发

同 `openCustomEditor` 的形状（`manager.ts:1047` + `ipc/plugins.ts:181` 的注释已经写明立场）：**主进程只校验与广播，不认识 Tab**。

- `tabs.openWebApp`：校验 `webAppId` 在自己清单里 → 取出 URL → 广播 `plugins:openTab`。
- `tabs.openBrowser`：查 `tabs.browser` 权限（能力门自动做）→ `matchesHostPermission(manifest.hostPermissions, url)` → 广播。
- `tabs.openView`：校验 `viewId` 在自己 `contributes.views` 里、且 `location !== 'editor'`。

`PluginManagerDeps` 增加 `openTab(pluginId, target, open)`，在 `ipc/plugins.ts` 里接成 `windows.emitToAll('plugins:openTab', …)`。

### 4.4 工作区变更事件的**事实来源**（诚实地限定范围）

仓库里**没有**文件系统 watcher（`ipc/workspace-search.ts:13` 记了为什么不用 `fs.watch`）。为它新引一个递归 watcher 是一笔与本计划不相称的成本与风险。

采用**宿主中介的变更流**：在三处已经存在的写入口各发一条通知 —

1. `ipc/workspace-files.ts` 的写/删/重命名；
2. kernel 工具的文件写入（`Write`/`Edit`/`MultiEdit` 收口处）；
3. 插件自己的 `workspace.writeFile` / `deleteFile`（`rpc.ts:136/160`）。

`PluginManager` 聚合 → 按订阅者的 `globs`（复用 `matchesPathScope`，前缀匹配，不引 glob 引擎）过滤 → 100ms 合批 → 推 `kind: 'event'`。

**必须写进文档的边界**：外部编辑器 / git checkout 改的文件**不会**触发这个事件。不写清楚的话，作者会把它当 watcher 用，然后在「为什么我在 VS Code 里改了没反应」上耗掉一天。

### 4.5 窗口交互（quickPick / input / confirm / progress）

主进程不画 UI。做法：`manager` 生成 `requestId` → 广播 `plugins:interaction` → 渲染层用既有 `components/ui/**` 画（Dialog / Menu / Input，19 个原子控件里已经有）→ 用户答完走 `plugins:interactionReply` → manager 按 requestId resolve 那个 Promise。

- 超时：`PLUGIN_TIMEOUT.REQUEST_MS`（30s）之内没有回执 → resolve 成 `null` / `false`，并记一条 activity。**不 reject**：用户没理会一个弹窗不是错误。
- 插件被禁用 / 休眠 / 窗口关闭时，所有挂起的 requestId 一律 resolve 成取消值，避免泄漏。
- ★ 顺带修一处既有技术债：`ipc/plugins.ts:130` 与 `:163` 现在用 `dialog.showMessageBox` 拼**裸英文句子**弹系统框（`approve` 与 `requestPermissions`），违反「主进程只传 key」。同一条回执机制正好能把这两处也搬到渲染层。**这一项标记为可选**：它不阻塞任何新能力，但同一套代码顺手能修，且注释里已经写着「计划 P2」。

### 4.6 `contributes.themes` / `skills` / `agents` / `modes` 落地

- **skills**：`SkillRegistry`（`kernel/skill/registry.ts:13`）增加一条「外部来源」注入，`PluginManager` 在插件启用/禁用时增删该插件包内的 skill 目录。装载失败按 `kernel/skill/load.ts` 的既有规矩变 diagnostics。
- **agents / modes**：同形，接进 `agents:list` / `modes:list` 的数据源，条目上带 `source: { pluginId }`，让扩展页能显示「来自插件 X」且**不可编辑**（插件提供的资源不能在本地被改写，否则升级时丢失）。
- **themes**：解析包内主题 JSON → 映射到 `styles/theme.css` 的 token 名 → 作为可选外观出现在设置页。★ 只接受**已知 token 名**的白名单，未知键丢弃：主题文件是第三方内容，让它往 `:root` 上写任意 CSS 变量等于把样式层交出去。

四者共同规则：**插件禁用/卸载 → 贡献的资源立刻消失**，且当前正在用某个插件主题时回落默认主题（不是白屏）。

### 4.7 engines 判定改造（D1）

`manager.ts:335` 改用 `engineCompatibility(manifest.engines, PLUGIN_API_VERSION)`；`'deprecated'` 推 warn 诊断、照常运行；`'incompatible'` 维持现有 error 行为。`PluginCatalog` 增 `apiVersion`。

---

## 5. L2 渲染层（`src/renderer/src/**`）

### 5.1 先补一个 `services/plugins.ts`（AGENTS.md §1 的已知违规）

`stores/plugins.ts`、`views/extensions/plugins/PluginConfiguration.tsx`、`settings/pages/import/ImportPage.tsx:82` 现在直接写频道字符串。本计划要给插件域新增 6 条以上通道，**再往 store 里堆频道字符串会把这个违规钉死**。所以：新建 `services/plugins.ts`，把既有调用与新调用统一收口。

这是本计划里唯一一次「顺手修既有坏味道」，理由是它正好在改动路径上，且不修会放大。

### 5.2 入口三落点（用户选择：外层功能 Tab / 内层 Tab / 右侧面板都要）

- **侧边栏**（`shell/Sidebar.tsx:125` 的 `<nav>`）：`contributes.webApps[].entry === 'sidebar'` 的条目 + `sidebar/nav` 菜单贡献，排在内置功能项之后，图标走白名单，文案走 `plugin.<id>.<key>`。
- **落点**由 `open` 字段决定：
  - `'feature'` → 新的外层 Tab。需要扩 `FeatureKind`？**不扩**：`OuterTab` 增加一支 `{ kind: 'pluginWebApp'; ref: { pluginId, webAppId } }`，理由与 `InnerTab` 的 `custom` 分支同构（`shared/domain/tab.ts:136` 的注释：pluginId 与标识都要落盘，插件不在了要降级而不是让 Tab 消失）。
  - `'tab'` → 内层 Tab，新增 `InnerTab` 分支 `{ kind: 'webapp'; ref: { pluginId, webAppId, url } }`。
  - `'right'` → 同内层 Tab，但走 `openPath` 那套右侧面板机制（`stores/tabs.ts:182` 一带的既有规则：无条件展开右侧、已开着但在别的 pane 就搬过来）。
- **降级**：插件卸载/禁用/error 时，webapp Tab 渲染 `EmptyState` 并说明是哪个插件，与 `views/plugins/CustomEditorView.tsx` 的降级完全同构（**复用那套文案与结构，不另写一版**）。

### 5.3 webapp 视图

新建 `views/plugins/PluginWebAppView.tsx`：内部复用 `views/browser/BrowserView.tsx` 的 `<webview>` 装配（`partition={browserPartition(workspaceId, profileId)}`、`allowpopups={false}`、只允许 http(s) 导航）。

★ 必须复用而不是新写一个 webview：`BrowserView.tsx:37` 那段注释描述的导航限制（不能跳到 `ncw://`、`file://`、脚本协议）是安全边界，抄第二份一定会漏。若结构上不便复用，则把 webview 的装配抽成同目录的 `browser-webview.ts` / 一个受控组件，两处共用。

导航策略：**限制在 `hostPermissions` 声明的 host 内**；点到站外链接 → 走 `openExternal` 交给系统浏览器（与卡片 `link` 块同一立场）。这条让「B 站插件」不会变成一个不受限的浏览器。

### 5.4 `contributes.views` 真正可挂载

`location: 'sidebar'` → 侧边栏下半的一个可折叠区块；`'panel'` → 内层 Tab（`PluginViewFrame` 挂在 Tab 里，无 `document` 绑定）；`'editor'` → 保持今天的行为（给 customEditor 当 UI）。

★ `CustomEditorView.tsx:64` 现在取 `views[0]`。加了 `location` 之后必须改成「取第一个 `location === 'editor'` 的视图」，否则一个既贡献侧栏视图又贡献编辑器的插件会把侧栏 HTML 当编辑器打开。**改这一行时保留原注释里「两张表」的解释**，只补充新的挑选规则。

`onView:<id>` 激活事件在视图第一次挂载时触发（webapp 插件不涉及）。

### 5.5 6 个菜单挂载点接线

统一走 `usePluginsStore().menuItems(menuId, context)`（`stores/plugins.ts:360` 已经是通用实现，只是没人按别的 id 调它）：

| menuId | 接线点 | `when` 上下文 |
|---|---|---|
| `tabBar/context` | `shell/InnerTabBar.tsx` 的 Tab 右键菜单 | `tabKind`、`isDirty` |
| `explorer/context` / `explorer/new` | 文件树的右键 / `+` 菜单（`views/files/**`） | `resourceExtname`、`resourceScheme`、`isDirectory` |
| `sidebar/nav` | `shell/Sidebar.tsx` 功能入口区 | `hasWorkspace` |
| `chat/composer` | `views/chat/Composer.tsx` 的工具栏 | `hasAttachment`、`isRunning` |
| `commandPalette` | `shell/SearchPalette.tsx`（与 `usePluginCommands` 合流去重） | — |

★ `Composer.tsx` 是 2291 行的热点文件（AGENTS.md §12/§15）。这里**只加一处挂载点**，菜单项的构造与过滤放在新的 `views/chat/composer-plugin-menu.ts` 纯逻辑文件里，组件里只有一行调用。

### 5.6 斜杠命令

`Composer.tsx:557` 的 `slashItems` 现在合并 agents / commands / skills 三个来源。插件贡献的斜杠命令作为**第四个来源**加入同一个数组（带 `pluginId` 标记，UI 上显示来源）。选中 → `services/plugins.ts` 的 `runSlashCommand` → 主进程 → `command.run` invocation。

合流逻辑同样抽到 `composer-plugin-menu.ts`（或现有的 slash 逻辑所在纯逻辑文件），便于单测。

### 5.7 卡片新原语渲染

`views/chat/CardRenderer.tsx` 按 §3.5 加 4 个分支 + `button.confirm`。`markdown` 块复用 `components/markdown/**` 的受信渲染器（`onOpenExternal` 已经接好，见 `WorkspaceMarkdownProvider.tsx:18`）。

### 5.8 交互请求 UI

新建 `shell/PluginInteractionHost.tsx`，订阅 `plugins:interaction`，用既有 `components/ui/Dialog` / `Menu` / `Input` 画，回 `plugins:interactionReply`。进度条挂在 `shell/StatusBar.tsx`（插件状态栏格子已经在那里渲染）。

★ 订阅必须在 `App.tsx` 起一次并把 `on()` 的返回值放进 cleanup（AGENTS.md §1 第 4 条，`App.tsx:139` 有反面教材注释）。

### 5.9 `ncw:doc:dirty`

`shell/PluginViewFrame.tsx` 的 `onMessage` 补 dirty 分支 → 调 `services/plugins.ts` 的 `setCustomEditorDirty` → 主进程 `customEditors.setDirty` 的同一张表 → `plugins:confirmClose` 因此有数据可查。**这条是在修一个静默丢数据的路径**（关 Tab 不提示未保存）。

### 5.10 i18n

按 AGENTS.md §6.3 新建 `i18n/plugin-ui.ts`（`pluginUiZh` / `pluginUiEn`），**不往 3965 行的 `index.tsx` 里堆**。覆盖：webapp 入口标题兜底、降级空态、交互弹窗的按钮、进度、新增能力 `tabs.browser` 的说明文案、engines 弃用诊断的人话版本。两份 catalog 键必须一致（`i18n/index.test.ts` 会校验）。

---

## 6. L3 文档与示例（`packages/**`、示例包）

### 6.1 `packages/plugin-api/nextcowork.d.ts`

- **删掉**今天宣称但（修复前）不存在的描述里与实现不符的部分；补齐 §3.4 的全部新方法、§3.5 的新卡片原语、`kind: 'webapp'` 与 `contributes.webApps`。
- 每个新 API 的 doc comment 写清**权限**与**失败形态**（返回 null / 抛 code）。
- `version` 常量与 `PLUGIN_API_VERSION` 对齐（`nextcowork.d.ts:27` 的注释说明两者关系，要同步更新）。

### 6.2 `plugin-builder` Skill

同步：engines 默认值改 `^0.3.0`、webapp 零代码章节、新贡献点与新权限、新卡片原语、`when` 可用变量表、工作区事件的**边界说明**（§4.4）。删掉 `env.openExternal` 之外仍不存在的任何描述。

### 6.3 `packages/create-nextcowork-plugin`

- `DEFAULT_ENGINES` 从 `^0.2.0` 改 `^0.3.0`（`index.mjs:37`）。
- 增加 `--template webapp`：生成一份**只有 package.json + l10n + icon** 的零代码包。

### 6.4 示例插件（用户明确要）

`examples/plugins/ncw.bilibili/`（不进主构建，仅作端到端样本）：

```jsonc
{
  "publisher": "ncw", "name": "bilibili", "kind": "webapp",
  "displayName": "哔哩哔哩", "version": "0.1.0",
  "engines": { "nextcowork": "^0.3.0" },
  "l10n": "./l10n",
  "permissions": [],
  "hostPermissions": ["https://www.bilibili.com/*", "https://t.bilibili.com/*"],
  "contributes": {
    "webApps": [{
      "id": "home", "title": "%app.home%", "icon": "tv",
      "url": "https://www.bilibili.com/", "open": "tab", "entry": "sidebar"
    }]
  }
}
```

零 JS、零权限勾选、装上即在侧边栏多一个「哔哩哔哩」，点开在当前工作区的浏览器分区里打开（已登录直接可用）。**这就是本计划的头号验收用例。**

---

## 7. 迁移与兼容

| 对象 | 影响 | 处理 |
|---|---|---|
| 已装的 0.2 声明插件 | 今天就是 error（§0.2） | `'deprecated'` 兼容 + warn 诊断，**变得能用**，不需要用户做任何事 |
| 老清单（无 `kind`） | 无 | 缺省 `extension`，解析结果逐字节不变 |
| 老清单（有 `views`，无 `location`） | 无 | 缺省 `'editor'` = 今天的行为 |
| 已落盘的 Tab 布局 | 新增 `webapp` / `pluginWebApp` 两种 kind | 只增不改；读到未知 kind 的老逻辑不变 |
| 新权限 `tabs.browser` | 只对新插件有意义 | 老插件 `required` 不变 → 不触发 `pending-approval` 扩权闸 |
| `PluginCatalog` 新增 `apiVersion` | 渲染层只读 | 可选字段，老窗口读不到时按 `hostVersion` 显示 |

---

## 8. 边界情况（每条都要有明确行为，不许「看情况」）

1. **没有打开工作区**：webapp 照常能开（它不碰文件）；`workspace.*` / `scm.*` 一律 `invalid_argument`（`narrowWorkspacePath` 对空根已经拒）。
2. **远程（SSH）工作区**：`ipc/plugins.ts:102` 一带已经对 connection 类工作区返回空根。webapp 不受影响；scm 一律拒绝并给出「远程工作区暂不支持」的诊断，而不是对本地仓库执行。
3. **webapp 的 URL 跳到站外**：不在 webview 内导航，交系统浏览器。
4. **插件被禁用时**：statusBar 清空（既有）、菜单项消失（既有 `isRunnable` 过滤）、webapp Tab 降级空态、skills/agents/modes/themes 贡献撤下、挂起的交互请求取消、工作区订阅移除。
5. **同名冲突**：两个插件贡献同一个 `webApps[].id` / `slashCommands[].name` → 按 `pluginId` 排序稳定取先者，后者推一条 warn 诊断（不静默丢）。
6. **`tabs.openBrowser` 的 URL 不在 `hostPermissions`**：`invalid_argument` + activity 记一条 denied，**不弹窗**（同 `canRequest` 的立场：清单之外的东西不给用户「点允许」的机会）。
7. **交互弹窗在插件休眠期间的回执**：插件已睡 → 丢弃回执并记 activity，不唤醒它。
8. **`process.execStream` 的输出洪流**：合批 + 总量上限 + `truncated` 标记；abort 后 2s 宽限（沿用 `PLUGIN_TIMEOUT.ABORT_GRACE_MS`）。
9. **主题插件被卸载而它正被使用**：回落默认主题并 toast 一次。

---

## 9. 测试与验收

新增/扩充的单测（`src/**/*.test.ts`，注意 `.test.tsx` 会被静默跳过，见 AGENTS.md §13）：

- `shared/plugin/__tests__/api-version.test.ts`：`^0.2.0` 在 0.3.0 下判 `deprecated`、`^0.3.0` 判 `ok`、读不懂判 `incompatible`（**不是** ok）。
- `shared/plugin/__tests__/manifest.test.ts` 扩充：webapp 规则（有 `main` 报错、缺 `webApps` 报错、声明 tools 报错）、新贡献点、新激活事件、老清单解析结果不变（回归锚点）。
- `shared/plugin/__tests__/tool-card.test.ts`：4 个新原语的消毒、未知 type 仍降级、超预算整体丢弃。
- `main/plugin/__tests__/rpc.test.ts`（新）：`env.openExternal` 非 https 拒、`scm.commit` 无 `scm.write` 拒、`workspace.subscribeChanges` 的 glob 过滤。
- `main/plugin/__tests__/webapp.test.ts`（新）：webapp 插件装载后 **runtime.spawn 一次都没被调用**。
- `main/plugin/__tests__/host.test.ts` 扩充：新方法的四道门顺序（未知方法 → `unknown_method`，而不是 `permission_denied`）。
- `renderer/.../__tests__`：菜单合并在 6 个新挂载点上的 clamp 与 `when` 过滤；webapp Tab 在插件缺席时的降级；斜杠命令合流去重。

端到端手动验收清单：

1. 装 `ncw.bilibili`（目录安装）→ 侧边栏出现「哔哩哔哩」→ 点开在内层 Tab 里加载 B 站 → 与浏览器 Tab 共享登录态。
2. 同一个包改成 `open: 'feature'` / `'right'` → 三种落点都对。
3. 禁用该插件 → 入口消失、已开的 Tab 变降级空态且写明插件名 → 重新启用 → 恢复。
4. 一个 `engines: ^0.2.0` 的老插件装上 → **能跑**，详情页有一条弃用 warn。
5. 写一个最小插件依次调 `openExternal` / `clipboard` / `showQuickPick` / `showInputBox` / `configuration.get` / `scm.status` / 注册拦截器 → 全部成功（今天全部失败）。

命令（AGENTS.md §14）：`npm run typecheck:web`、`npm test`、`npm run lint`；主进程改动还要跑仓库既有的 `typecheck`。

---

## 10. 落地顺序（分层，但有依赖）

1. **L0 的 §3.1 + L1 的 §4.7**（engines 解耦）——不先做这个，后面任何示例插件都装不上。
2. **L1 的 §4.1**（补死 handler + 垫片）——独立可验收，立刻让 d.ts 变诚实。
3. **D2/D3 + §3.2/3.3 + §4.2/4.3 + §5.1/5.2/5.3** —— B 站示例端到端跑通。
4. **§3.6 + §5.4/5.5/5.6** —— 贡献点补全。
5. **§3.4/3.5 + §4.4/4.5/4.6 + §5.7/5.8** —— 能力面扩展。
6. **L3** —— 文档、d.ts、脚手架、示例随各阶段同步更新（不留到最后一次性补）。

---

## 11. 风险与明确不做

- **风险 1：改动面横跨 main/shared/renderer 与热点文件**（`Composer.tsx`、`i18n/index.tsx`、`stores/session.ts` 之外还有 `manager.ts` 1460 行）。对策：新逻辑一律落新文件（`composer-plugin-menu.ts`、`i18n/plugin-ui.ts`、`services/plugins.ts`、`PluginWebAppView.tsx`），热点文件里只留一行挂载点。
- **风险 2：webview 安全边界被抄第二份**。对策：§5.3 强制复用/抽取，不允许新写一套 webview 装配。
- **风险 3：工作区事件被当成 watcher 用**。对策：文档 + d.ts 注释里写明覆盖范围与不覆盖的场景。
- **明确不做**：push/pull、交互式终端、任意 CSS 注入式主题、跨插件执行命令（`manager.ts:1079` 的立场不变）、`configuration.set`（`protocol.ts:125` 的立场不变）、`tabs.close`（`protocol.ts:113` 的立场不变）。
