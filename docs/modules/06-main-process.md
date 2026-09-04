# 06 · 主进程外壳 `src/main`（除 kernel）

> 入口、装配、IPC handler、状态仓、窗口注册。内核（kernel/）之外的部分 —— electron 的**值**导入只允许出现在 `index.ts` 与 `host/index.ts`。

| 文件 | 行 | 一句话 |
|---|---|---|
| `index.ts` | 146 | 入口：单实例锁 / 启动时序 / 建窗 / 退出钩子 |
| `runtime.ts` | 233 | 装配单例：host + router + tools + seed + runAgent（**零 electron import**） |
| `host/index.ts` | 79 | `electronHost()`：paths/secrets/fetch 三覆盖 + 演示上游叠加 |
| `ipc/index.ts` | 216 | 注册全部 handler：契约完备映射 + `todo()` 占位 + safeHandle + 防抖落盘 |
| `ipc/agent.ts` | 161 | 合批泵 RunPump + startRun/attachRun/abortRun |
| `ipc/app.ts` · `settings.ts` · `workspace.ts` · `provider.ts` · `errors.ts` | | 各频道 handler |
| `state/store.ts` | 132 | 内存状态仓（步骤 6 换 SQLite，**当前无磁盘持久化**） |
| `window/registry.ts` | 124 | 定向事件推送，绝不广播 |
| `db/probe.ts` | 59 | node:sqlite 能力探针 |

## 1. 启动时序（`index.ts`）

```
模块顶层（app ready 之前）
  requestSingleInstanceLock()      :18  ★ 必须在 whenReady 之前 —— 两实例开同一 SQLite，有 WAL 也打架；
                                        「第一天就加，后补要动启动时序」
  dev: userData 加 -dev 后缀        :25  ★ ready 之前调用才生效；开发不污染真实数据
whenReady
  logStartupProbe()                :104  异步 fire-and-forget：node:sqlite 版本 + fts5/json1/rtree；
                                        失败只打日志（退回 better-sqlite3 的信号），不阻塞启动
  initRuntime(electronHost())      :113  ★ 必须先于 registerIpc —— 渲染层第一个 invoke 是 app:getBootstrap，
                                        bootstrap 要带 seed 出来的默认模型；顺序反了首屏模型选择器是空的
                                        host 也在此时构造：safeStorage 与 net.fetch 都要求 app ready
  registerIpc()                    :117  ★ 必须先于建窗 —— 渲染层第一个 invoke 可能在窗口 show 之前就到
  createMainWindow()               :119  ★ windows.register 先于 loadURL —— 「渲染层的 window:ready 一到
                                        就要能查到 kind；登记晚了 markReady 走兜底分支，kind 判断不准」
before-quit
  flushPendingPersists()           :142  ★ Tab 布局防抖 500ms —— 退出前不 flush，「用户最后一次拖出来的
                                        顺序就丢了 —— 而那正是他最可能记得的一次操作」
  shutdownRuns()                        停掉所有在跑的 run（定时器/上游流会拖住退出）
```

`createMainWindow` 细节：1280×820 / min 900×600 / `show:false` 等 ready-to-show / `backgroundColor:'#1c1b19'` / darwin `titleBarStyle:'hiddenInset'`（红绿灯嵌侧边栏）；`webPreferences` 三件套 `sandbox:true + contextIsolation:true + nodeIntegration:false`（★ sandbox 是 preload 必须单文件打包的原因）；`setWindowOpenHandler` 只放行 `https://` 到系统浏览器、一律 `deny`；`will-navigate` 挡站外导航。

## 2. `runtime.ts` —— 装配

- ★ **本文件零 electron import**（`:4-10`）：「哪天有人在这里加一个 electron 的**值**导入，挂的会是 `agent-pump.test.ts` 和 `agent-run.test.ts`，而那是正确的报警。」第二个理由是**收口**：`ipc/agent.ts` 只该关心「合批与推送」，不该同时知道 provider 表、工具注册、演示上游。
- 四个模块级单例 `host / router / tools / seeded`。★ `installHost` 换宿主时 **`router = null`**（`:39-44`）——「路由器在构造时抓住了 host 的引用，换宿主必须让它重建」；这一条被 `agent-run.test.ts:359-386` 执法（装 401 宿主后新一轮必须 `error.code='auth'` —— 否则症状是「改完设置页没反应，重启才对」）。
- `providerConfig` 是**函数而非快照数组**：`providers()/aliases()/failoverEnabled()` 每次现查 store，设置页改完 provider 立刻生效。
- `seed()`（`:75-136`，幂等闸）做四件事：
  1. ★ **演示 provider 与别名总是进表**（不是「没有别的 provider 时才进」）：priority 100 全表最低，真 provider 一配上就压过它 ——「『什么时候该有演示上游』这个问题根本不需要答案」；
  2. 默认模型：`defaultModel === ''` 时 seed 成 `nextcowork-demo`（★ 已选过就不覆盖，「否则用户选的模型每次启动都被顶回演示上游」）；
  3. 默认工作区 `ws-default`：根目录在 `userData/workspaces/default` —— ★ **刻意不在 `process.cwd()`**（打包后 cwd 在应用包内，fs 工具会以「围栏之内」的名义写进应用包）；`mkdirSync` 失败标 `unavailable:true` 不拦启动；
  4. 前置 `listWorkspaces().length === 0` —— 用户自己开过就不再塞。
- `runAgent(handle, req)`（`:192-223`）：构造 `AgentSession({host, upstream, tools, workspaceRoot, history: store.getHistory(req.sessionId)})` → `session.run()` → `.finally(store.setHistory)`。
  - ★ **`history` 是多轮的全部实现**：缺省空转录意味着模型每轮从零开始 ——「那不是『步骤 6 还没做』，是对话功能是坏的」。
  - ★ **`.finally()` 而不是 `.then()`**：中断路径上 `finalizeAbort` 已把半截回复和补上的 tool_result 写进 history，不落盘下一轮就是 400。
  - **不 catch**：`AgentSession.run()` 承诺不抛异常，结局一律经 `handle.finish`；「真加一个 catch 反而会掩盖那个承诺哪天被破坏」。
- ⚠️ `workspaceRootFor` 查不到工作区时回退 `paths.temp()` 是**步骤 9 之前的显式占位**：「落地时必须改成拒绝 —— 没有工作区就不下发文件工具，而不是给它一个能写的临时目录」。

## 3. `host/index.ts` —— electronHost()

| 端口 | Electron 实现 | 备注 |
|---|---|---|
| `paths.userData/temp` | `app.getPath(...)` | 平台约定目录的唯一权威 |
| `secrets` | `safeStorage.encryptString/decryptString` + 进程内密文 Map | ★ 落盘从头到尾是密文，「明文一次都没离开过这两个函数」；`isEncryptionAvailable()===false` 时**明确抛错拒绝存储**（明文落盘/静默丢弃都是不可接受的降级 —— 前者让用户以为被系统保护，后者让设置页显示已保存、重启却为空）；⚠️ Map 仅内存，接通后也不跨重启（步骤 6 换 SQLite 表） |
| `fetch` | `net.fetch`（补一层适配，它不吃 `URL`） | 走 Chromium 网络栈：系统代理、企业证书、设置页「代理」才对模型请求生效 |
| clock/logger/fs/spawn | 不覆盖（用 `nodeHost` 默认） | 「覆盖它们只会多一份要同步维护的代码」；fs/spawn 默认 `notYet` 抛错 |

- ★ 就绪守卫（`:62-68`）：`!app.isReady()` 抛「必须在 app.whenReady() 之后调用」—— 早一步拿到的是「看起来正常、实际不可用的 host」，症状推迟到第一次发请求，错误里已没有「调早了」这条线索。
- 最外层 `withDemo(nodeHost({...}))` 叠加演示上游（按主机名分派，见 [05 篇 §6](./05-kernel-upstream.md)）。

## 4. IPC 层

### 4.1 `ipc/index.ts` —— 注册机制

- **编译期保证**：`handlers: HandlerMap` 是完备映射 —— 往 `IpcInvokeMap` 加频道却忘写 handler，`npm run typecheck` 当场拦下（这正是 `build` 脚本把 typecheck 前置的原因）。handler 入参/返回类型由频道直接推导。
- **运行期保证**：`safeHandle`（`:177-192`）包成 `IpcResult`；★ 异常绝不穿过 `ipcMain.handle`（stringify 后错误分类全丢）。日志策略：`NotImplementedError` 只 `console.warn` 不打堆栈（「后面还有十几步没实现，每步都往控制台糊一屏堆栈的话，真正的错误就沉底了」）；`unknown` 错误 `console.error` 带频道名。
- `todo(channel, step)`（`:47-51`）：契约已登记、未到实施顺序的频道，抛带步骤号的明确错误 ——「刻意不留空：『契约完整/实现进度』两件事在同一个文件里就能对上」。当前分布：步骤 4（provider 写入面、agent:listTools）、步骤 5（交互）、步骤 6（sessions/storage/search）、步骤 8（terminal）、步骤 10（mcp）、步骤 12（skills）、步骤 13（gateway）。
- **send 处理**（`:152-166`）：`window:ready` → `windows.markReady`；`tabs:persist*` → 防抖；`terminal:write/resize` 目前**空函数体**（终端按键被静默丢弃）。遍历 `SEND_CHANNELS` 注册时**必须 try/catch** —— send 没有回程信封，一个畸形载荷就是主进程里的 uncaught exception。
- **防抖落盘**（`:125-150`）：`PERSIST_DEBOUNCE_MS=500`；`pendingPersists` 连**值一起存住**（「退出时要写掉它，不是丢掉它」）；`flushPendingPersists()` 在 before-quit 逐条写。键名收口 `outerTabKey/innerTabKey`。⚠️ 「落盘」目前是**写进内存 kv 表** —— store 无磁盘持久化（§5）。

### 4.2 `ipc/agent.ts` —— 合批泵

- **存在理由**（`:1-10`）：一个 token 一条 IPC 消息，每条都要付一次结构化克隆 + 一次主线程跳转。合批刻意**不放进 RunRegistry** —— 内核零 electron，而「往哪个 webContents 推」是彻头彻尾的 electron 概念。
- `FLUSH_MS = 16`（≈一帧；方案 §8 给 16–33ms：「再快没意义（渲染层反正等 rAF），再慢就能看出打字延迟」）；`MAX_BATCH = 64`（工具吐几万行时，时间窗内能攒出一个大到卡住克隆的批）。
- ★ `isCoalescable`：只攒 `stream` 里的 `text_delta / thinking_delta / tool_call_delta` 三种 ——「其余事件都是**结构性**的：消息提交、工具起止、待决交互、run 结束 —— 要么改变 UI 结构，要么用户正等着它出现」。这同时实现了「内容块边界立即 flush」。
- `RunPump.push`：入 buf、更新 lastSeq；不可合批或攒满 64 → 立即 flush；`run_end` 时自删。★ **批内 seq 必须连续**：「信封只带最后一个 seq，渲染层用 `envelopeFirstSeq()` 反推。所以攒进 buf 的事件一个都不能丢，哪怕当前没有窗口在看。」这条不变式的另一半在 `shared/ipc/contract.ts` 的 `hasSeqGap()` —— 改一边必须同时改另一边，否则渲染层每收一批就 attach 一次。
- ★ **没人订阅时整批丢弃**（`:82-85`）：「run 继续跑，日志继续记，窗口回来时走 attach 重放。停的是推送，不是 run。」
- `startRun(req, ctx, driver=runAgent)`（`:114-129`）★ **订阅在前、启动在后**：`windows.subscribe` → `runs.create` → `pumps.set` → `void driver(...)`，两件事在同一个同步块里，中间插不进任何事件。★ RunDriver 做成**参数**而不是可写模块变量：「后者要在每个测试后复位，忘了复位的那个测试会莫名其妙地跑起真上游来。」
- `attachRun`（`:131-149`）★ 三步顺序：**先 flush**（泵里攒着的事件已在日志里，不先冲掉会既出现在快照里、又被推给刚订阅的窗口 = 重复）→ 再订阅 → 最后取快照；2、3 之间同样插不进事件。run 不存在时抛 `IpcError` 而非空快照（「空快照会被当成『run 存在但没事件』，UI 就永远转圈了」）。
- `shutdownRuns`：`abortAll({by:'shutdown'})` → 逐泵 flush → 清 pumps（「留着的 setTimeout 会拖住退出」）。⚠️ 不调用 `runs.reap()`。

### 4.3 其余 handler

- **`app.ts`**：`getBootstrap(windowKind)` 一次拿全（windowKind/settings/resolvedTheme(`nativeTheme.shouldUseDarkColors` 解析 'system')/workspaces/tabState/activeRuns/versions）——「不让渲染层开局打七八个 invoke，否则每个组件都得写一遍 loading 分支」。★ `activeRuns` 硬编码 `[]`：正常冷启动一定空（「永不恢复运行中状态」），非空只在 ⌘R 后 —— 注释承诺「接上 RunRegistry 后按 workspaceId 聚合查询」**尚未兑现**（数据源 `runs.runningIn()` 已存在未接线）。`openExternal` 只放行 https：「与 setWindowOpenHandler 一条规则，两个口子」。`registerThemeBridge`：`nativeTheme.on('updated')`，仅 `theme==='system'` 时 `emitToAll('theme:changed')`。
- **`settings.ts`**：update 后**无条件** `emitToAll('settings:changed', next)`（多窗口下在快捷窗改了主题主窗必须跟着变 —— 这是 GlobalEventChannel 的正当用法）；`patch.theme` 变化时额外 `applyThemePreference` + `theme:changed`。补丁语义（顶层标量整给、嵌套块只给要改的属性）见 [02 篇 §4](./02-shared-contract.md)。
- **`workspace.ts`**：`pick` 走 `dialog.showOpenDialog` + 立刻 `realpathSync.native`（/var → /private/var，不归一化则路径围栏后面要面对两个都「正确」的根）；同 rootPath 已存在则更新 `lastOpenedAt` 并清 `unavailable`。★ `listDir` 三条写下的事：req.path 是**不可信输入**一律过 `resolveInWorkspace`；**不递归懒加载**（「不只是交互，它是 node_modules 不会一次性把 IPC 撑爆的原因」）；`withFileTypes` 与逐项 `statSync` 分开（指向不存在目标的软链会抛 —— 那一项按「文件、无大小」处理，不让整次列目录失败）。★ `close` = 从**记录**里移除，与「关闭外层 Tab」是两回事。
- **`provider.ts`**：只读两条先实现（模型选择器的唯一数据源）。★ 走 `store` 而不是 `getRouter().listModels()`：「一个正在冷却的 provider 不该从下拉框里消失 —— 它应该显示出来并标成不可用，否则用户会以为自己的配置丢了」。★ **显式 `ensureSeeded()`**，否则全新安装点开下拉框是空的。排序按 provider priority、同 provider 内保持配置顺序（「下拉框的顺序是用户资产，不该按字典序重排成他不认识的样子」）。
- **`errors.ts`**：`IpcError{code,message,status?}` 是 handler 主动拒绝的方式；`NotImplementedError` code 固定 `'unknown'` 但消息指明步骤；`toAgentError` 映射链：IpcError 原样 → `isAbortError` → `'aborted'`（★ 必须走 kernel 的判断：「只看 `err.name==='AbortError'` 会漏掉 undici 那个形状 —— 用户点了停止，却收到一个 `code:'unknown'` 的错误弹窗」）→ 其余 `'unknown'`。

## 5. `state/store.ts` —— 内存状态仓

| 数据 | 载体 |
|---|---|
| `settings` | 变量，初始 `structuredClone(DEFAULT_SETTINGS)`；出入均 clone（杜绝外部改内部状态） |
| `workspaces` | `Map<id, Workspace>`；`listWorkspaces` 按 `lastOpenedAt` 降序 |
| `providers` / `aliases` | 两个 Map；★ **别名主键是 `(providerId, alias)` 不是 alias**：「同一个 alias 由多个 provider 提供正是别名表存在的理由；用 alias 当主键，故障切换就只剩一个候选」 |
| `kv` | Tab 布局等易失 UI 状态 |
| `transcripts` | `Map<sessionId, AgentMessage[]>`，内存无上限 |

- ★ 复合键分隔符 `KEY_SEP = '\u0000'` **写成转义而非字面控制字符**：「源码里的真 NUL 在编辑器和 diff 里隐形，grep 会把整个文件当二进制静默不匹配 —— 那种『搜不到』比一个报错难查得多」（本文档的 04 篇就真的踩了一次）。
- `removeProvider` **级联删别名**：「留下一条指向已删 provider 的别名，表现是『模型还在下拉框里，选了却报没有已启用的供应商』—— 没人会想到去看删 provider 那段代码」。
- ★ **当前没有任何磁盘持久化**（全仓无 `writeFile`/`JSON.parse` 落盘路径）：「防抖 500ms 落盘」实际是防抖写入内存 kv。因此 Tab 布局**跨应用重启不恢复**，能恢复的是「⌘R 重载而主进程未重启」的场景。文件头声明这是刻意的：「步骤 6 会被 `src/main/db/` 整体替换 —— 所以这里刻意只暴露最小访问器，handler 不直接摸数据结构，换成 SQLite 时改这一个文件即可。」

## 6. `window/registry.ts` —— 定向推送

- 定位：方案 §3 规则 5 —— 事件按订阅**定向推送，绝不广播**。「⌥Space 快捷小窗不该收到主窗的 token 流。即使现在只有一个主窗，这也是**正确性问题**，不是多窗口特性。」
- **类型级规则**：`TargetedEventChannel = 'agent:event' | 'terminal:data' | 'terminal:exit'`（只许 `emitToTopic`）；`GlobalEventChannel = Exclude<EventChannel, Targeted>`（只许 `emitToAll`）——「想拿 emitToAll 推 agent:event，编译期就过不去。」
- topic：`run:<runId>` / `term:<terminalId>`。`subscribe/unsubscribe` 维护 `topic → Set<webContentsId>`；`hasSubscribers(topic)`（「没人看时可以停掉合批泵，但**不停 run 本身**」）。
- `register(sender, kind)` 建 ctx 并挂 `once('destroyed')` 清理（否则 topics 无限增长、每次 emit 都对着一堆死 webContents 判断）；`markReady` 已登记则就地改 kind；`of(sender)` 未注册的一律当主窗（顺带 register）—— 所以 quick 窗必须主动发 `window:ready {kind:'quick'}` 才会被正确归类。
- ★ `send` 每次前判 `isDestroyed()`：「窗口刚关掉、事件泵还有一批在路上 —— 不判就是一个 "Object has been destroyed"」；发现已销毁顺手 `forget`。

## 7. `db/probe.ts`

「Electron 编译自己的 Node 构建 —— 上游 Node 24 有 node:sqlite，不代表 Electron 的 Node 一定编进了它。」必须**动态 import** 包在 try/catch 里（静态 import 在模块加载时就抛，探针就没得探了）。探测：`:memory:` 打开 → `sqlite_version()` → fts5（全局搜索的刚需）/ json1 / rtree。失败结论决定走 better-sqlite3@13（需 rebuild + asarUnpack，与 node-pty 同一条链路）。

## 8. 测试固化行为（`ipc/__tests__`、`state/__tests__`）

- **agent-pump.test.ts**（显式传假发射器作第三参数）：信封 seq 全程连续（`gaps===0`）；200-delta 突发合批（总 200 事件、信封 ≤5、单批 ≤64）；结构性事件立即 flush 且在批末位；转录重建（提交后活跃块清空、progress 清掉）；中断终局 `aborted` 且 `transcript.error` undefined；★ ⌘R 重放「裁剪对重建无损」（重放事件数更少但转录一模一样）；运行中重载增量紧接快照 seq 不重复不缺口；无人订阅整批丢弃但 run 跑完；★ attach 顺序 flush→subscribe→snapshot（反向 = 「甲乙丙甲乙丙」重复投递）；attach 不存在的 run 抛错；★ 信封与快照都能过 `structuredClone`（「这是无头测试唯一漏掉的那一跳：真 IPC 会结构化克隆，它拒绝函数/class 实例 —— 症状是主进程抛 "An object could not be cloned"，一条与业务毫无关系的报错」）。
- **agent-run.test.ts**（一个 driver 参数都不传，走默认驱动 = 真 AgentSession + 演示上游）：端到端 parts `text(用户那句)/text/tool_call/tool_result/text`（★ 首个 text 是用户自己发的）；★ 别名被翻译（请求写 alias、`message_start.model` 是 upstreamModel）；没配过的模型 → `no_healthy_provider`；工具执行途中中断每个 tool_call 仍配上**错误** result（★ 用 30s 慢工具逼中断真的落进窗口 —— delayMs=1 时全看运气）；thinking:'auto' 通（encode 抬 max_tokens → 演示上游校验）；两个 run 并行各推各的订阅者；同会话第二个 run 接着写、跨会话不串台；★ 换宿主路由器必须重建（用 `demoHost({fetch})` 而非 `withDemo` —— 后者按主机名分派什么也验不出来）。
- **errors.test.ts**：IpcError 分类原样带过；裸 Error/非 Error 归 unknown 保留消息；中断四条形状（DOMException、node AbortError、★ undici `TypeError{cause}`、已分类的 IpcError 不被嗅探覆盖）。
- **store.test.ts**：测的是**契约**不是代码 —— 「换成 providers/model_aliases 两张表之后，这份测试必须原样还能跑过」。三条：别名主键 `(providerId, alias)`（含 U+0000 防 `a`+`|b` 撞键）；删 provider 连带删别名；provider 列表按 priority 升序（「依赖插入顺序的话，『先配哪个』就悄悄决定了『先切到哪个』」）。

## 9. 已知偏差清单（注释与实现的差距）

| # | 注释/契约说 | 实际 |
|---|---|---|
| 1 | Tab 布局「落盘」「重启就没了」 | store 全内存；只跨 ⌘R 恢复，跨应用重启不恢复 |
| 2 | `getBootstrap.activeRuns`「接上 RunRegistry 后按 workspaceId 聚合」 | 硬编码 `[]`（`runs.runningIn()` 已存在未接线） |
| 3 | 密钥托管：safeStorage、只写不读 | `electronSecrets()` 已实现但 `provider:setCredential/getCredentialInfo` 是 todo（步骤 4），链路不可达；密文 Map 仅内存 |
| 4 | `gateway:status/failover` 事件 | 只有契约与白名单，无 emit 点；健康/冷却逻辑全在内核 router，UI 拿不到 |
| 5 | 终端频道 | 4 个 invoke handler 是 `todo()`，2 个 send handler 是空函数体，2 个 event 无发射器；node-pty 从未被 import |
| 6 | `shutdownRuns` | 只 abort + flush + 清 pumps，不 `runs.reap()`（已结束 run 的日志留存到进程退出） |
| 7 | `workspaceRootFor` 的 temp 兜底 | 步骤 9 落地时必须改成拒绝 |
