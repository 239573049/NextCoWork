# 08 · 渲染层 `src/renderer`

> React 19 + zustand + Tailwind v4 的**纯 IPC 客户端**：不持有 Node / 网络 / 凭证能力，不做任何模型 HTTP 调用。

## 1. 入口链与视图分发

```
index.html（内联严格 CSP；dev 下被 cspDevPlugin 整段替换）
  → main.tsx（StrictMode + theme.css）
    → App.tsx（86 行，只做四件事）
        ① startAgentEventPump() 一次          ★ 不在 ChatView 里起 —— 否则五个 chat Tab 把同一批
                                                 事件 apply 五次、seq 校验立刻炸
        ② 三个全局订阅 settings/theme/workspace:changed（清理函数全调用，防 HMR 叠加）
        ③ 握手：announceReady('main') → getBootstrap() → hydrate(b) → adoptActiveRuns(b.activeRuns)
           ★ 时序照协议：window:ready(send) → app:getBootstrap(invoke) → 首屏 → 增量事件
        ④ useRunIndex() → runningSessionIds / runningWorkspaceIds 两个 Set（RunRegistry 的投影）
    → AppShell → InnerTabBar + InnerView / Sidebar / Panels
```

`views/registry.tsx`（94 行）**不引 react-router**：Tab 化应用天然不是 URL 驱动，且生产 `file://` 下必须 HashRouter，白白多一层。纯 switch 分发六种内层 Tab（chat 已实现；terminal/doc/draw/browser/preview 为 Placeholder，注明是第几步）+ `FeatureView`（外层 feature Tab，全部 Placeholder；★ **设置不走这里 —— 它是模态浮层**）。★ `INNER_VIEW_KINDS: Record<InnerTabKind, true>` 是类型层面的穷尽性哨兵 —— 加一种 kind 忘了写视图，编译期就挂。★ chat 分支 `key={tab.ref.sessionId}` 而不是 tab.id：同一 Tab 换会话时必须重建 per-session store 订阅，否则新会话继续画上一个会话的转录。

## 2. 服务封装层 `services/`

组件**不直接引用频道字符串**（协议 §9）。`ipc.ts`（70 行）做两件事：

- `invoke()`：拆 `IpcResult` 信封，失败抛 `AgentErrorException(readonly error: AgentError)` —— UI 据 code 决定跳设置页/提示 compact/重试。
- `tryInvoke()`：返回原始信封，给「失败也是正常结果」的场景（当前唯一用户是 DataPage —— 未实现频道会抛 `NotImplementedError`，`invoke` 把它变成异常，`void getStats()` 没接住就是 dev 下一条 unhandled rejection）。
- `on()` 返回退订函数，「返回值必须被 useEffect 的清理阶段调用」。
- `bridge()`：桥不存在立刻大声挂掉。

各模块：

| 模块 | API | 关键注释 |
|---|---|---|
| `app.ts` | 握手 / 设置 / 工作区 / Tab 布局 | ★ `updateSettings` 嵌套块只给要改的属性，别自己 `{...settings.gateway, x}` 组装 —— `settings` 是 prop，广播回来之前它是旧的。`listDir` 「树懒加载，展开一个目录才调一次 —— 别在这里写递归」。`persistOuterTabs/persistInnerTabs` 用 **send 不用 invoke**（拖动排序每帧都在变，主进程侧防抖 500ms） |
| `agent.ts` | `startRun/attachRun/abortRun/onAgentEvent` | ★ `startRun` **刻意不返回 runId**：「如果返回，调用点会写 `const id = await startRun(...)`，而 await 之后再订阅就晚了 —— 首批 token 在 promise resolve 前就发出去了。签名上拿不到 runId，这个错就写不出来。」 |
| `provider.ts` | `listProviders/listModels` | |

## 3. zustand stores

### 3.1 `window.ts`（231 行）—— 窗口级

State：`windowKind / outer: OuterTab[] / activeOuterId / activeWorkspaceId / sidebarCollapsed / rightPanelOpen / bottomPanelOpen / settingsPage`。

- ★ **`activeWorkspaceId` 是显式状态、不是从 `activeOuterId` 派生**：它有两个消费者（内层 Tab 条 + 侧边栏会话区）；「定时任务」这类 feature Tab 激活时侧边栏仍显示原工作区会话列表 —— 派生式写法在那一刻会算出 null，整个侧边栏下半闪空。只在**激活一个工作区 Tab 时**更新。
- `hydrate(b)`：★ **过滤掉持久化数据里的 `settings` 功能 Tab**（类型允许但没人开，旧 kv 里可能躺着一条，放进来就是第二个设置入口）；自动补的第一个 Tab 也要落盘，否则每次启动换新 id、拖出来的顺序莫名回退。★ `settingsPage` 一个字段兼表「开没开」和「开在哪一页」，拆两个值必然有不同步的一刻；放 store 不放 useState，因为有的调用点够不着组件树（session store 的错误分支里只有 `getState()`）；**不落盘**。
- `close`：焦点给右邻、没有给左邻（浏览器习惯）；★ 关掉工作区 Tab = 这个工作区退出内存（`tabs.forget(workspaceId)`）——「曾经这两个释放函数都写好了却没有任何人调用，于是开过的每个工作区、每段转录都留在内存里直到退出」；正在跑的 run 不受影响（活在主进程）。
- `openFeature('settings')` 改道 `openSettings()`，不建 Tab 不落盘。

### 3.2 `tabs.ts`（207 行）—— 内层 Tab，按 workspaceId 索引

★ 按 workspaceId 索引而不是按窗口 —— 这是「切回某个工作区，它的 Tab 全都还在」的全部实现。State：`byWorkspace: Record<string, InnerTabState>`。

- `withActive/activeIn`：★ 两格的激活项存在**不同字段**（`activeTabId` / `bottomActiveTabId`），因为它们是同时可见的两条 Tab 条；合成一个字段的话点底部终端会把主区正在看的对话取消激活。
- `loadOrSeed()`：★ 这一趟 IPC 期间用户可能已自己开了一个 Tab，那份是新的，别覆盖；有持久化就原样 set、**不回写**（「读回来的和写出去的是同一份，不回写 —— 否则每次启动都白打一次盘」）。
- `ensure()`：★ 挂在 effect 上会被重入，用模块内 `loading: Set` 闸；失败降级「新工作区」且 `finally` 释放闸（「挂 then 上的话失败一次这个工作区就再也 ensure 不动了」—— restore.test 钉住）。
- `close()`：★ 下一个激活项在**本格内**顺位递补（「关掉底部的终端不该跳到主区的对话上」）；★「关掉最后一个就补一个空对话」**只对主区成立** —— 底部空掉是合法状态（对应「收起面板」），照搬到底部就永远关不掉。
- `move()`：`reorderInPane`，from/to 是**该格内**下标（shared 纯函数）。
- ★ `forget()` 是**唯一放得掉会话 store 的地方** —— 内层 Tab 表是全应用唯一知道「这个工作区有哪些 sessionId」的东西；对每个 chat Tab 调 `releaseSession`，正在跑的放不掉。

### 3.3 `session.ts`（321 行）—— per-session store + 事件泵 + run 索引

文件头：① ★ **流式文本必须住这里不能住全局**（放全局则每个 token 让 Tab 栏、侧边栏跟着重渲染，一秒几十次全树 diff）；② 懒创建、工作区关闭时销毁（会话可能几百个）。加上主进程 16ms 合批 + 这里的 rAF 再缓冲，就是全部流式性能方案；**不做 ack/流控**。

State：`activeRunId`（★ 一个会话同一时刻只有一个 run）/ `lastSeq` / `transcript: TranscriptState` / `queuedInputs` / `lastOptions` / `draft`。

- **`send(text, opts)`**：① 单 run 不变式 —— `activeRunId !== null` → 进 `queuedInputs` 后 return；② ★ 渲染层 mint runId（ulid），`registerRun(runId→sessionId)` **先于** `startRun`（「第一个事件回来时泵知道投给谁，而 startRun 的 await 还没返回」）；③ ★ **只清「本轮」的部分**：`messages/tools` 必须留着 —— 整个 `emptyTranscript()` 换上去的话发第二条消息就把第一轮问答从屏幕上抹掉；★ 用户这条消息不在这里补 —— 主进程会为它发 `message_commit`，这边补一条就成了两条 id 不同的同一句话。
- **`stop()`**：只 `abortRun(runId, true)`，★ **状态不在这里改** —— 等 `run_end` 事件回来；中断路径上主进程还要做收尾（§4.8 五件事），UI 抢先置 idle 就看不到那个过程。
- **`applyEnvelope`**：非本会话 run 的信封直接丢弃；★ `hasSeqGap` → `resync()`（attach 重放）并 return；正常路径 `applyEvents` + `settleRun` + `drainQueue`。
- ★ **`settleRun` 两件事必须一起做所以它不是纯的**：`run_end` 时 `unregisterRun` **并**返回 `{activeRunId: null}`。「运行中」圆点读全局 `runIndex`，输入框/状态行读会话 store —— 两份状态得同时收。历史 bug：只收后一半，「正常跑完的那些圆点一直亮着 —— 外层工作区 Tab、内层对话 Tab、侧边栏会话行同时挂着三颗」。
- `drainQueue`：run 结束自动发出排队的下一条；★ 复用 `lastOptions`（出队续跑**不能读当时的 UI 值**，用户可能在排队期间改了模型下拉）。
- ★ **run 索引是 RunRegistry 的投影，不是 UI 状态**（`session.ts:218-224`）：试金石是「关掉最后一个正在观看某个运行中会话的 Tab，run 依然活着，且外层工作区 Tab 上仍显示角标」。单独一个 store 不塞进 window store：它每个 run 起止各变一次，而 window store 一动整条 Tab 栏就重渲染。`adoptActiveRuns` 首屏把主进程还活着的 run 补回索引（⌘R 场景）。
- ★ **`releaseSession` 正在跑的会话放不掉，返回 false**：run 活在主进程的 RunRegistry 里，渲染层关掉几个 Tab、乃至关掉整个工作区，都不该让它消失。曾经这里连 `runIndex` 条目一起删 —— 那等于渲染层单方面忘掉一个还在跑的 run：事件泵反查不到会话，事件被静默丢弃，重新打开看到一段停在半路、再也不会动的转录。判「在不在跑」读 `runIndex` 而不是 `activeRunId`（⌘R 后索引补了、store 还没人碰过）。
- ★ **`resync` 绝不能对 `snapshot.events` 再跑 gap 检查**：重放 seq 可能不连续（message_commit 处裁剪），直接应用后把 lastSeq 置成 `snapshot.seq`；对它查连续性会导致**无限 resync**。
- ★ **单一事件泵**：全应用一个 IPC 监听器按 runId 分发（每个 store 各自订阅 = 每条事件过 N 个回调、退订责任分散 N 处 —— 漏退订正是 HMR 监听器叠加的成因）。`startAgentEventPump` 幂等；★ **rAF 再缓冲**：主进程已合过一次批，这里再对齐到帧，一帧内多个批合成一次 `set()` = 一次 React 渲染。

### 3.4 转录 reducer（实现在 `shared/agent/transcript.ts`）

session store 只是壳，**哪些事件改什么状态**全在纯 reducer 里（理由见 [02 篇 §3.5](./02-shared-contract.md)）：

| 事件 | 改什么 |
|---|---|
| `stream/message_start` | `model` |
| `text_delta` / `thinking_delta` | `live` 中对应 index 块追加（`upsertBlock` 插入时排序 —— 上游不保证升序） |
| `tool_call_start` | live 块置 kind/callId/name |
| `tool_call_delta` | live 块累积 argsDelta |
| `tool_call_end` | **no-op** ★ 不 JSON.parse —— 解析是内核的事；UI 的 input 来自 `tool_start` |
| `message_end` | `usage` |
| `stream/error` | `error` |
| `provider_retry/switch` | no-op（已在事件流里，第 4 步只需加分支） |
| `message_commit` | ★ **提交即清空活跃块**（漏掉 = 全文重影）+ `messages.push` |
| `tool_start` | `tools[callId] = running` |
| `tool_progress` | 更新 progress（易失；找不到 prev 则 no-op） |
| `tool_end` | status ok/error + output + 清 progress |
| `context_usage` | `contextUsage` |
| `run_end` | `status` + 可选 error |
| `interaction_*` / `subagent_*` | no-op（步骤 5、11 接管 —— **permission 请求/交互卡片当前无 UI**） |

### 3.5 `models.ts`（56 行）

模型表是**应用**数据不是窗口状态（混进 window store 的话一次刷新让整条 Tab 栏重渲染）。★ `loaded` 标志：加载完成前下拉显示「加载中」而不是「一个模型都没配」；★ 失败也置 `loaded: true`（否则永远停在「加载中」，用户看不出是失败了）；★ 模块级 `inflight` promise 共享 —— 五个 Tab 同时挂载只发一次。

### 3.6 谁写谁读

| 数据 | 写 | 读 |
|---|---|---|
| 外层 Tab 表 | 渲染层唯一权威，变更后 `send(tabs:persistOuter)` | 主进程只在启动经 `Bootstrap.tabState` 回吐 |
| 内层 Tab 表 | 渲染层 `write` 即 `send(tabs:persistInner)` | 按 workspaceId 懒取回 |
| 工作区列表 | 主进程（广播 `workspace:changed`） | App.tsx 持有往下传 |
| 设置 | `updateSettings(patch)`，主进程深合并后广播（含发起者） | App.tsx 唯一权威，页面组件收 prop 不做镜像 |
| 运行中 run | 渲染层 mint + registerRun；重载时 `Bootstrap.activeRuns` 单向补回 | `runIndex` → 两个 Set |

## 4. Shell 布局

### 4.1 AppShell（211 行）—— 悬浮面板布局

窗口四周留 8px，侧边栏（297px）与内容区是两块独立圆角面板，中间也是 8px 缝（`--color-app` 从缝里透出来）。★ 全局基本不用 box-shadow，靠底色差分层。

两个文件头级 ★：

- ★ **`app-drag` 与 Tab 拖动排序正面冲突**：macOS `hiddenInset` 让顶部 34px 落在自绘标题栏（`-webkit-app-region: drag`），**OS 吞掉该区所有 pointer 事件**，表现是「Tab 拖不动，整个窗口跟着鼠标跑」→ drag 只给 Tab 之间的空白，每个 Tab 元素自己 `app-no-drag`。
- ★ 设置是模态浮层不是一个 Tab —— 做成 feature Tab 的话「关掉设置」和「关掉一个工作区」就成了同一个动作。

DOM 要点：34px 标题条（`items-end` 让 30px 的 Tab 顶边离条顶 4px —— ★ 「改这个数之前先去量图（scripts/crop.mjs + 竖线扫描），别凭手感」）；`chrome` 不是 `surface`（浅色下外层 Tab 条比侧边栏**更暗**，用 surface 会让整条 Tab 浮起来，层次正好相反）；★ **底部面板只压在左列下面**（右侧文件栏是通栏的，终端不该把它顶掉）；无独立状态栏（会话状态在 `StatusLine`）。

### 4.2 红绿灯

- 展开态：Sidebar 头部 `pl-[74px]` 给红绿灯让位、整条 `app-drag`。
- 收起态：标题条 `pl-[78px]`；展开按钮 38×28 药丸、`active` 挖暗+强调色 —— 四个参数（宽 38/高 28/药丸轮廓/垂直居中）全是**从截图量出来的**（x=104 竖扫盒子 y11..38 等）；按钮尺寸与收起态一致，「否则一收一放图标会跳一下大小」。

### 4.3 Tab 条与拖拽重排

- `OuterTabBar`（203 行）：**浏览器式标签** —— 激活那张 `bg-canvas` 与内容面板同色、上圆角、无下边框，读起来是「这张标签就是下面那一页的舌头」；未激活的**没有底色**。★ Tab 图标不用强调色（激活态靠「整张 Tab 挖到画布色 + 文字变实」表达，不靠「图标变彩」）。运行中角标 = `size-1.5` accent 圆点，数据源 `runningWorkspaceIds`。★ 弹性空白 `min-w-6 flex-1` 是**故意**留给窗口拖动的 —— 整条 Tab 区唯一没有 no-drag 的地方。
- `InnerTabBar`（140 行）：★ **同一个组件供主区与底部两条 Tab 条使用**，差异收进 `menu`/`trailing` 两个参数而不是抄一份组件（「抄一份的代价是：悬停态、关闭按钮、拖动手感会慢慢长歪」）。形状与外层**故意不一样**（药丸 `rounded-[8px]`）—— 两层长得一样的话「这个 Tab 属于哪一层」只能靠位置猜。★ 菜单分隔是**数据**（`separatorBefore`）不是渲染时的 `i === 3` —— 底部菜单多一项「文件预览」，按下标算就错位了。
- `useDragReorder.ts`（141 行）：手写不引 dnd 库 —— 外层 Tab 条落在 drag 区，HTML5 拖放行为随 Electron 版本漂移；pointer 事件 + `setPointerCapture` 是可预测的路。三个不显然的点：① **4px 起拖阈值**（没有它每次点击都被算成零距离拖动，`reorder(i,i)` 虽 no-op 但会白走一遍 activeTab 写入和布局落盘）；② **落点按拖起时的位置快照算**，不按实时 DOM（拖动中其它 Tab 正在 translate，实时 rect 是动画中间态，判定会来回跳）；③ **监听挂在元素上且 `pointercancel` 也要收**（只写 up 的话拖到一半系统抢走指针，这个 Tab 就永久捕获着它）。让位动画：被拖的从左往右穿过时中间那些整体位移一格。
- `Sidebar`（271 行）：★ 上下两半作用域不同不能混在一个 store（上半功能入口全局、下半会话区由 `activeWorkspaceId` 派生 ——「切了顶部 Tab 但左边没跟着变」这个 bug 在结构上就写不出来）；上半 `NAV_FEATURES` 不含 settings；下半「最近对话」列表当前是**已打开的 chat Tab** 而非历史会话表（步骤 6 换 SQLite）；★ 297px 定宽别改成可拖的（29 张截图里面板体一律 x=8..304）。★ 页脚原是账户区，NextCoWork 没有账户体系（方案 §10 砍掉商业化面）——「形状留着，含义换掉」：显示「本地模式 / 数据只存在这台电脑上」+ 设置入口。
- `Panels.tsx`：`WorkspaceFilesPanel`（旧实现，正被 `views/files/FilesView.tsx` 取代）与 `BottomPanel`（★ 不是「终端面板」，是第二条内层 Tab 条 —— 组件自己不持有任何 Tab 状态，全部由 AppShell 喂进来）。

## 5. Chat 视图

### 5.1 `ChatView.tsx`（100 行）

per-session store 的**唯一**消费者 —— 流式文本只让这棵子树重渲染。★ **空会话不是「一个空的对话界面」，是另一屏**：问候语 + 输入框**竖直居中**（参考截图 c6184031），没有插画、没有状态行、输入框不贴底 ——「贴底的输入框加一张居中插画，看起来像是内容没加载出来」。

### 5.2 `Thread.tsx`（241 行）—— 转录怎么渲染

- ★ **已提交 parts 和还在流的 live 块走同一套块渲染器**（`parts.tsx`）—— 一个块从「流式中」变成「已提交」的那一瞬间不该跳动，两套渲染必然会跳。
- ★ **`isToolResultOnly` 的消息必须过滤掉**：工具结果在内部格式里是一条 user 消息，不滤掉的话每次工具调用后都会多出一个空白用户气泡，「长得完全像一个 bug，查起来却要一路翻到消息模型才明白」。
- ★ **没有空态分支是故意的**：走到这里而 `visible` 为空只剩一种处境 —— run 已起、第一个事件还没到，那一瞬该是空白转录区，不是「还没有开始对话」的插画（插画会闪一下再被文字顶掉）。
- 跟随滚动：依赖是**块数**不是整个 transcript（「每个 token 都触发一次 scrollIntoView 会和用户自己的滚轮打架」）。
- part 分发：`tool_result` → **null**（工具结果折在 tool_call 卡片里 —— 单独再画一遍是同一件事显示两次）；`error` → mono 红字；`LiveTurn` ★ 光标只跟最后一个文本块后面（跟每块后面就是一排闪烁的方块）；流式中的工具参数**原样显示片段而不是尝试 parse**（中途 JSON 一定非法）。
- `Prose`：★ Markdown 解析**推迟到块边界**（方案 §8），v1 按纯文本渲染。

### 5.3 `parts.tsx`（166 行）

- `ThinkingBlock`：可折叠行，★ 流式中**默认展开**（思考先于正文到达，收着的话用户盯着空白等好几秒），提交后收起。
- `ToolCallCard`：入参和结果都**折叠**（一个 read_file 的结果可达 60KB，全铺开把对话冲垮；「展开是用户的选择，不是默认」）；★ `data-testid="tool-call"` + `data-tool-status` —— e2e 探针读它而不是正则「完成/失败」这些会改的中文字；截断提示带原始字节数。
- ⚠️ permission 请求/交互卡片**当前没有 UI**（reducer no-op，契约已备好 `agent:respondInteraction`，`useFocusTrap` 注释说步骤 5 的审批弹窗要用同一套）。

### 5.4 `StatusLine.tsx`（113 行）与 `Composer.tsx`（374 行）

StatusLine：★ **同时是 e2e 探针的读取点** —— `data-status/data-seq/data-model/data-queued` 是机器可读属性，不是给人看的那句中文（「探针去正则一句会随文案改动的话，产品界面就得永远背着一个调试字符串」）。三样数据（model/usage/contextUsage）都是已有事件的直接投影。★ 压力条**平时不画**（`PRESSURE_SHOW=0.5`）——「一个 3px 高、无标注的条只有在读数本身值得看的时候才传递信息；用了 4% 的上下文不值得看」；`shouldCompact` 时加「接近上限，可 /compact」。

Composer 两个文件头级 ★：

- ★ **药丸不是设置项的快捷方式，它就是发送时读取的那个值**（方案 §4.5）：权限档位放在输入框左下角而不是设置页里，说明档位是**每次发送时**读的当前值，run 一开始就冻结在 `RunRequest` 里 —— 这正是设置页那句「更改会在下一次新回复生效」。「本地 state 是权威，发送时打快照；顺带写回工作区当新默认值。反过来（以工作区为权威）会让药丸点下去有延迟。」
- ★ **生成中不禁用输入框**，占位符改「当前回复完成后按队列继续执行」（队列语义在 session store）。

实现要点：

- ★ **切工作区 = 换一套默认值，刻意不用 `useEffect([workspace.settings])`**：药丸每改一次就 `updateWorkspace` 写回，主进程广播回来时 `settings` 是新引用，effect 会把用户刚点的值再「重置」一遍，「看起来就是药丸点下去闪一下又弹回原样」。改用 React 官方「渲染期按 key 调整 state」写法。
- `patch()` 失败只记日志：「药丸已经生效了，一个存不下来的默认值不值得打断用户正在写的这句话」；★ `toSettings` 只写五个字段 —— WorkspaceSettings 还有 `activeSkillIds`，直接 spread 会把它抹掉（两边字段名一致但**不是同一个类型**）。
- ★ 生效模型解析 `value.model → fallbackModel → models[0]`，**兜底结果不写回工作区**：「用户没选过，`defaultModel` 就该继续是空的。静默替他做主的话，以后他在设置页改了应用默认模型，这个工作区却不跟着变，而他并不知道自己什么时候『选』过。」
- ★ Enter 发送、Shift+Enter 换行，**`!e.nativeEvent.isComposing` 判断** —— 「输入法组词期间的 Enter 是『上屏』不是『发送』，少了这个判断中文用户每打一个词就发一次」。
- 药丸排布：左边「这一轮怎么执行」（权限档位/`/`会话模式/`+`更多），右边「发给谁」（模型选择器 + 发送按钮）—— ★ 两头分布，「模型和发送按钮是一件事的两半，挤在左边那堆开关里会被当成又一个开关」。只读徽标重复显示 `+` 菜单里已开的项，「让它们在收起状态下也看得见」。
- ★ `surface-input` 不是 `surface-raised`：浅色下输入框是**纯白**而 raised 卡片是 #f2eee6，合并了输入框就沉进背景。

## 6. `views/files/FilesView.tsx`（457 行，最新）

右侧「工作台标签」里默认那个。头注释列了五条照截图落下来的行为：① `对话文件/所有文件` 两档 scope（选中态靠**字重+字色**不靠底色）；② 工具条随面板宽度收起 —— 宽面板七颗全展开、窄面板只剩「搜索 + …」，★ **不是两套 UI 是一套按溢出**（「折叠只是换个呈现，不是另写一套精简版工具条，那必然会慢慢长歪」），用 `ResizeObserver` 而不是窗口宽度（★ **右侧面板自己是可拖宽的，窗口没变而面板变了才是常态**）；③ 懒加载，展开一层拉一层；④ 目录在前文件在后（shared `sortEntries`）+ 彩色文件图标；⑤ 行三态。

- `load` 失败只让**那一行**显示失败，不把整棵树打空；`refresh()` ★ 展开状态**留着**（「刷新是重新读盘，不是把我打开的目录都收起来」）。
- `flatten()`：★ 递归的是**展开状态**不是网络请求；★ 搜索在**已加载的部分**里过滤且**命中的祖先目录保留**（否则命中项失去缩进上下文）。
- `TreeRow`：`role="treeitem"`、缩进走 padding 不走嵌套 div（★ 树是平铺渲染的，虚拟化和键盘导航将来都只面对一维数组）；★ 箭头占位一律画（没有它文件名比同级目录名左移 14px）。
- 点文件 → `onOpenFile(path)` 在**右侧工作台**开一个 doc Tab，「这个组件不自己渲染文件内容」。

## 7. UI 组件库与品牌

| 组件 | 关键设计 |
|---|---|
| `Menu` | **不用 radix DropdownMenu**：外层 Tab 条落在 drag 区，面板要显式 `app-no-drag`，而 radix 把面板 portal 到 body 下类名够不着。Esc 必须 `preventDefault` 宣告消费（「设置浮层也在 document 上等 Esc，不标记会同时关掉菜单和整个面板」）；`checked: false` 仍占位免得整列跳动 |
| `IconButton` | ★ 静息色 `icon`、激活色 `accent` 是**两个分开的 token**（「一度写成静息就是 accent，那是只看深色参考得出的结论 —— 深色那套两者同值，合并了也看不出来，浅色合并就错」）；`active` 挖暗、悬停偏暖，两个维度分开所以不会互相盖掉 |
| `TextInput` | ★ **故意不含草稿逻辑**（设置搜索框要逐键受控、端口/代理地址要失焦提交，两类调用点正好相反）；Escape 用 `preventDefault` **不能用 stopPropagation**（React 合成事件的 stopPropagation 管不到 document —— 约定「document 级 Escape 消费者一律先查 `e.defaultPrevented`」）；`.selectable` 必须（全局 `user-select:none`，输入框自己 opt-in） |
| `NumberInput` | ★ 内部状态是 **string 不是 number**（`value={number}` 表达不了「刚删空准备重打」的中间态）；失焦/回车才提交；外部值只在**没有焦点时**回灌；非法**原样还原**不悄悄夹边界 |
| `Slider` | ★ **`onChange` 与 `onCommit` 必须分开**：拖动中每帧一次 `updateSettings` = 每帧一次 IPC + 一次全窗口广播；自绘槽 + 盖透明原生 range（原生管键盘/触摸/无障碍，自绘管长相） |
| `Segmented` | ★ 配色：槽是暖的(tint)、选中项是暗的(surface-sunken) —— **选中不是被点亮，是被挖下去** |
| `brand/ProviderIcon` | 用 `@lobehub/icons-static-svg`（★ 不用 React 版：它 peer-depends antd 整套组件库；★ 用 `?raw` 内联而不是 `<img src>`：lobehub 单色图标 `fill="currentColor"`，`<img>` 里的 SVG 继承不到外部颜色）。★ `dangerouslySetInnerHTML` 的安全论证：注入字符串全部来自**编译期常量**（31 条显式 `?raw` 导入），运行期输入只用来**挑选**是哪一个常量 —— 不存在从运行期数据流进被注入字符串的路径。★ 静态列举不用 `import.meta.glob`（全量 903 个 1MB+，认得的就 31 个）；类型 `Record<Brand, string>` 让「brands.ts 加了规则却忘了加导入」成为**编译错误** |
| `brand/brands.ts` | 31 牌 + `RULES` 顺序即优先级（★ `ollama` 在 `meta` 前 —— 「Ollama」里含着「llama」，松散匹配会认错；改 `\bllama` 又漏 `codellama`，靠顺序两边都对）；★ 这张表放纯函数文件里为了能在 node 环境测试 —— 「正则顺序错一位，就会有模型显示成别家的 logo，而且没人会报 bug」。认不出返回 null 是正常路径不是错误 |
| `lib/file-icon.ts` | ★ 彩色文件树不是装饰：一屏三十行文件名靠字形读不出结构；★ 色相全部走已有 token + 少量调色板，**不新增主题变量**（「这是语法高亮性质的，跟深浅主题走的是明度不是品牌色」） |
| `lib/accelerator.ts` | ★ mac 上修饰键间不带 `+`（`⌘N` 不是 `⌘+N`）；★ `isMac` 是**参数**不是模块常量（vitest 的 node 环境没有 `navigator`，模块级读取会在 import 时抛） |

## 8. Settings 体系

- **页面已实现**：`General/Preference/Model/Connection/Data/About/Stub` 七页 + `Row.tsx` 排版 + `useFocusTrap` + `props.ts`。**模态浮层容器（SettingsOverlay）尚未实现**：`useWindowStore.settingsPage` 就位、`AppShell.onOpenSettings` 还是空回调。
- `nav.ts`：纯数据不 import React（`matchRows` 能在 node 环境测）。★ **十项是照参考图铺的，不是照「我们实现了什么」铺的** —— 被砍的四页直说被砍了或排在第几步，**不写「即将推出」—— 后者是在骗自己**。★ `SETTINGS_INDEX` 是唯一事实来源，页面组件从它取标题渲染（表和界面各写一份的话，搜出来点过去会落在没有那一行的页面上，而这种漂移没有机制报警）。★ `matchRows` 空查询返回**空数组**（调用点据此显示正常页面；返回全表的话一打开设置就是一屏搜索结果）。
- `props.ts`：★ `settings` 是 prop，**不在页面里 useState 一份镜像** —— App.tsx 已是唯一权威，主进程对所有窗口广播（含发起者），一次 `patch()` 自动回环成一次 setState；加乐观副本会把 Composer 那个「点下去弹回原样」的 bug 重新引进来。
- `Row.tsx`：`LandsAt`/`TodoRow` 约定 —— 「这个字段能存，但今天全应用没人读它」的行**点名将来是谁读它**（`defaultPermissionMode/subagent/gateway/proxy/notifications/locale` 目前全应用零消费者），藏起来不诚实、假装生效更不诚实。
- `validate.ts` `normalizeProxyUrl`：★ 缺协议补 `http://` 而不是拒绝（用户十有八九打 `127.0.0.1:7890`，那正是代理软件界面上显示的样子）；去尾部空路径（`http://x/` 和 `http://x` 存成两种写法后「有没有变」的比较就失效了）。
- `ConnectionPage`：代理地址用**草稿态输入框**（受控绑 prop 的话每敲一个字符就是一次 IPC 往返 + 广播回灌，光标会跳；且打字途中一定经过 `http:/` 这种非法中间态）；★ 渲染期回灌 + **有焦点不回灌**（「你失焦提交时最后写，你赢。桌面端这就是对的」）。
- `DataPage`：★ 用 `tryInvoke` 不用 `invoke`（未实现频道抛 `NotImplementedError`，没接住就是 unhandled rejection）；`alive` 标志防卸载后 setState。
- `ModelPage`：★ 已知缺口写在文件头 —— `Menu` 是 `absolute` 且不 portal，内容区 `overflow-y-auto` 会裁掉靠下的下拉，所以两个 picker 刻意放页面最上面。

## 9. 样式体系 `styles/theme.css`（226 行）

- 数值**不是调出来的，是从 docs/images 截图上采样出来的**：对不透明区域做主色直方图而不是取单像素（参考实现开了 macOS vibrancy，单像素取到的是「面板色 × 壁纸」的混合）。
- ★ 核心规律：**状态不靠「提亮」表达，靠「冷↔暖」和「凸↔凹」两个维度** —— 选中/激活往**暗**里挖（挖到和画布同色，读起来是「这块被打通了」）；悬停往**暖**里偏（明度几乎不变，只是加橙）。中性灰只负责结构，暖灰（tint 家族）只负责交互态。「把悬停做成 `bg-white/5` 之类的提亮，整套界面立刻就不像了。」
- 三层高度关系（**越靠外越亮**，和常见的反过来）：`#454849` 窗口底/浮层 → `#3d4041` chrome → `#333636` canvas。
- Tailwind v4：`@theme` 里的 token 直接生成工具类（`--color-canvas → bg-canvas`）；深色是基准值，浅色重新赋同名变量，工具类不用改。
- 全局 `user-select: none`、交互区 `.selectable` opt-in；`.app-drag/.app-no-drag`、`.scroll-thin`、`.fade-top` 工具类。

## 10. 快捷键现状与接线中事项

- **渲染层当前没有注册任何全局快捷键/应用菜单**（无 `metaKey`/`globalShortcut`）。⌘N/⌥⌘N/⌘T/⌘, 目前只是**显示字符串**（`INNER_TAB_MENU` 等经 `prettyAccelerator` 渲染成 `<kbd>`）；PreferencePage 的 description 明说「装在渲染层 document 上，窗口没聚焦时不响应 —— 要补得连一整套应用菜单模板一起补」。
- 现有键盘处理五处局部：Composer Enter/isComposing、TextInput commit/revert、Menu document-Esc、FilesView 搜索 Esc、useFocusTrap 的 Tab 环。
- 🔨 **接线中（写作时点）**：`files` 内层 Tab 的布线 —— `FilesView.tsx` 已完成、`Panels.tsx` 的 `WorkspaceFilesPanel` 正被替换、`AppShell.tsx` 对 `BottomPanel` 的 props 未接齐、`tabs.makeTab` 缺 `files` case；`npm run typecheck:web` 当前 3 条错误（AppShell 对 Panels 的两处引用 + BottomPanel 缺 props）。`settingsPage` 浮层容器（SettingsOverlay）待实现。
