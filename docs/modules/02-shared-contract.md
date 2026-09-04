# 02 · 共享契约层 `src/shared`

> 主进程、preload、渲染层三方共用的**纯类型 + 纯函数**层。对外依赖为零（全目录无 `electron` / `node:` import，测试只依赖 vitest）。
> 文件规模：`ipc/contract.ts` 343 行、`agent/*` 9 文件、`domain/*` 11 文件、`util/id.ts`、测试 6 个文件共 672 行。

## 1. 职责与内部依赖方向

```
ipc/contract.ts ──► agent/* + domain/*
domain/*        ──► agent/*   （仅 4 处下探：settings/session/workspace/bootstrap）
agent/*         ──► agent/*   （横向：event 依赖 stream/message/interaction/error）
util/id.ts      ──► （无依赖）
```

反向（agent → domain）不存在：**agent 是底层领域词汇，domain 是聚合/配置层，ipc 是最上层编排**。上层以相对路径引用（无路径别名），因此 shared 不能反向 import 任何上层模块 —— 例如「演示上游常量」因此留在 main 侧而非 `DEFAULT_SETTINGS`（`runtime.ts:85-87`）。

立约总纲（`contract.ts:4-12`，承接 `docs/ipc-protocol.md` 并四处收紧）：

| 协议文档 | NextCoWork |
|---|---|
| 两种返回风格「模块内保持一致」 | 只用一种 —— `IpcResult` 信封，全局一致 |
| 异常穿过 handle 传播 | 异常**绝不**穿过 handle |
| 长任务无序号、不可重放 | 信封带 seq，`agent:attach(sinceSeq)` 幂等重放 |
| 每个 API 方法内部硬编码目标频道 | 由契约生成白名单，preload 运行时校验 |

## 2. IPC 契约（`ipc/contract.ts`）

三张表共 **62 条频道**：`IpcInvokeMap`（47）、`IpcSendMap`（5）、`IpcEventMap`（10）。invoke 条目形状 `{req; res}`；send/event 条目直接是载荷类型。

### 2.1 IpcInvokeMap（渲染 → 主，要返回值）

| 模块 | 频道（req → res） | 备注 |
|---|---|---|
| app | `app:getBootstrap`(void→`Bootstrap`)、`app:openExternal`(`{url}`) | 一次拿全首屏，避免渲染层开局打七八个 invoke |
| settings | `settings:get`、`settings:update`(`AppSettingsPatch`→`AppSettings`) | ★ 嵌套块只给要改的属性（§4.1），返回合并后全量 |
| workspace | `list`、`pick`(→`Workspace\|null`)、`update`、`close`、`listDir`(`{workspaceId,path}`→`DirListing`) | ★ pick 走主进程 dialog，渲染层永不指定路径；close = 删**记录**≠关 Tab；listDir **懒加载不递归**，path 过 `resolveInWorkspace`，`../..` 被拒 |
| tabs | `tabs:getInner`(`{workspaceId}`→`InnerTabState`) | 读走 invoke，写走 send（读写分离） |
| sessions | `list/get/create/rename/setArchived/setFavorited/delete`、`conversations:searchAll` | 归档/收藏是两个独立 setter；searchAll 靠 FTS5 snippet |
| agent | `agent:run`(`RunRequest`→void)、`agent:attach`(`{runId,sinceSeq}`→`RunSnapshot`)、`agent:abort`(`{runId,cascade}`)、`agent:respondInteraction`、`agent:listInteractions`、`agent:listTools` | ★ runId 由调用方传入不由 run 返回（§2.4）；三种交互 kind 共用一个 respond |
| terminal | `create/kill/list/getBuffer` | 唯一原生模块（node-pty）领域，handler 均为 todo（步骤 8） |
| mcp | `list/upsert/remove/testConnection` | 步骤 10 |
| skills | `list/setGlobalEnabled/setWorkspaceActive` | 双闸：全局开关 × 工作区单独启用 |
| provider | `list/upsert/remove/setCredential/getCredentialInfo/listModels/test` | ★ setCredential 只写不读，返回 `{hasKey,last4}` 永不回传明文 |
| gateway | `getStatus/setEnabled/resetHealth`（→`GatewayStatus`） | 全部 todo（步骤 13） |
| storage | `getStats/vacuum` | 界面「数据」页 |

### 2.2 IpcSendMap —— 高频无返回

`terminal:write`、`terminal:resize`、`window:ready`、`tabs:persistOuter`、`tabs:persistInner`。这张表存在的理由就是终端（`contract.ts:191-194`）：每次按键做一次请求/响应往返，快速输入下肉眼可见地卡。Tab 布局用 send 是因为拖动排序每帧都在变，主进程侧防抖 500ms 落盘。

### 2.3 IpcEventMap —— 定向推送

`agent:event`、`terminal:data/exit`、`gateway:status/failover`、`settings:changed`、`theme:changed`、`workspace:changed`、`skills:changed`、`mcp:changed`。

★ 事件按订阅定向推送，**绝不广播**（`contract.ts:214-218`）：WindowRegistry 维护 `runId → Set<webContents>`，⌥Space 快捷窗不该收到主窗的 token 流；每次 send 前判 `isDestroyed()`。`skills:changed` 载荷是 `void`（只是「变了」的信号，收到后自己重拉）；`settings:changed` 等带全量新值（状态推送，由主进程广播给**所有**窗口，发起者也在内 —— 这是渲染层设置页不做本地镜像的前提）。

### 2.4 信封与 seq 机制

```ts
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AgentError }   // :50
export interface AgentEventEnvelope { runId: string; seq: number; events: AgentEvent[] } // :57
export function envelopeFirstSeq(env) { return env.seq - env.events.length + 1 }        // :71
export function hasSeqGap(env, lastSeq) { return envelopeFirstSeq(env) !== lastSeq + 1 } // :82
```

- ★ **异常绝不穿过 `ipcMain.handle`**（`:45-50`）：Electron 会把它 stringify 成一句话，`AgentError` 的 code 分类（UI 决定「跳设置页/提示 compact/重试倒计时」的唯一依据）全丢。
- ★ **seq 放信封上不放 event 里**，且是**本批最后一个**事件的序号；批内依次 `seq - events.length + 1 … seq`（`:53-64`）。发送端（合批泵）与接收端（session store）对「seq 指哪个事件」的理解一旦分岔，症状是每批都报缺口、每批都触发 attach，**看起来像网络抖动，实际是一个 ±1**。`envelopeFirstSeq` 因此只写一遍。
- `hasSeqGap` 把**重复的批也判为有缺口，是故意的**：attach 重放幂等，分辨重复/丢失需要维护已见 seq 集合，不值当。
- 渲染层不得对 attach 的**重放**事件跑 gap 检查 —— 主进程在 `message_commit` 处裁剪冗余 delta，重放 seq 可能不连续（`run-registry.ts:148-157`）；应用完直接把 lastSeq 置成 `snapshot.seq`。

### 2.5 白名单与编译期哨兵

- `INVOKE_CHANNELS` / `SEND_CHANNELS` / `EVENT_CHANNELS` 三张 const 表（`:248-317`），均 `as const satisfies Record<keyof XxxMap, 1>` —— **双向约束**：少写一条 → Record 缺 key 报错；多写一条 → 字面量多余属性检查报错。「由契约生成白名单」因此是可执行的保证。
- 运行期守卫 `isInvokeChannel` 等用 `Object.prototype.hasOwnProperty.call`（`:333-343`），**刻意不用 `in`** —— 否则 `'toString' in INVOKE_CHANNELS` 为 true，白名单被原型链击穿（测试 `contract.test.ts:100-109` 钉住）。
- 同模式的哨兵还有：`shared/domain/settings.ts:112-121` 的 `PATCHABLE_KEYS`（给 `AppSettings` 加字段忘在 `mergeSettings` 合并 → 编译红）、渲染层 `views/registry.tsx:86-94` 的 `INNER_VIEW_KINDS`。

## 3. Agent 领域模型（`shared/agent/*`）

### 3.1 两层事件

```
ProviderStreamEvent（上游层词汇，12 变体，stream.ts:26-47）      AgentEvent（内核层，超集，11 变体，event.ts:15-30）
├─ message_start {model}                                        ├─ stream {delta}          ← 透传
├─ text_delta / thinking_delta {index,text}                     ├─ message_commit {message} ← ★ 落盘边界，db 只在这里写
├─ tool_call_start/delta/end {index,callId,…}                   ├─ tool_start / tool_progress / tool_end
├─ block_opaque {index,opaque}   ← 厂商透传逃生舱                ├─ interaction_request / interaction_resolved
├─ provider_retry {attempt,delayMs}                             ├─ subagent_start / subagent_end
├─ provider_switch {from,to,reason}                             ├─ context_usage {used,window,shouldCompact}
├─ message_end {stopReason,usage:TokenUsage}                    └─ run_end {status,error?}   ← 终局
└─ error {error:AgentError}
```

★ 关键点：

- **index 是内容块序号，不能省**（`stream.ts:50-61`）：文本→工具→文本、并行工具调用都要靠它归位。
- **adapter 契约**：必须发 `tool_call_start … tool_call_end`，中间 delta 数量**可以为 0**；`argsDelta` 按字符串累积，**只在 end 时 JSON.parse 一次**，失败产工具错误不抛 —— 流式中途的 JSON 一定非法（`ToolCallAccumulator`，`stream.ts:63-100`，解码侧与测试共用同一份语义）。
- ★ `block_opaque`：Anthropic 扩展思考的 signature、redacted_thinking 从这里走。内核不解释 opaque，只负责搬运：decode → 事件 → `ContentPart.opaque` → encode。没有它 signature 下一轮原样回传就无从谈起（丢了就是 400）。
- ★ `context_usage` 在**请求发出前**发，UI 的上下文压力条要在这一轮真的挤爆之前就被看见（`event.ts:33-38`）。
- `TokenUsage` 的 `cacheCreationInputTokens/cacheReadInputTokens` 不能省（`stream.ts:19-21`）：开提示缓存那天，没有它们成本显示就是**静默错**的。

### 3.2 消息模型（`message.ts`）

- ★ **消息是内容块数组，不是字符串**（方案 §4.1）：同类产品无一例外从 `content: string` 迁到块模型且迁移成本极高；这里第一天就是块。每条记录带 `schemaVersion: 1`（最便宜的保险）。
- `ContentPart` 7 变体（`:18-25`）：`text` / `thinking{text,opaque?}` / `tool_call{callId,name,input}` / `tool_result{callId,output,isError}` / `subagent` / `image{mime,dataRef}`（**引用不内联 base64**）/ `error`。
- ★ **工具结果放在一条 user 消息里**（`toolResultMessage ≡ userMessage`，`:89-98`）：Anthropic 要求 tool_result 在紧随的 user 消息中；存成最终形状，编码器就只是映射，否则每加一个上游协议都要重写一次消息重排逻辑。
- ★ 双轨转录：`visibleText(m)` 是「模型看到的历史 = parts 的纯函数投影」；UI 看到的是另一套（审批提示、进度、子代理折叠）。`isToolResultOnly(m)` 让 UI 不把工具回执画成用户气泡。
- `orphanedToolCalls(messages)`：中断收尾必用 —— 找已开启没配对的 tool_call，漏掉它们下一轮消息数组就是非法的。
- ★ 截断在**产出侧**（`:110-127`）：`MAX_TOOL_OUTPUT_CHARS = 64*1024`，尾部追加「[输出已截断:共 N 字符…]」明确标记 —— 不是静默截断，模型看到标记才可能改用更窄的查询重试；一个 `cat` 40MB 的工具不截断就要过结构化克隆 + IPC + SQLite 写入 + 占上下文。

### 3.3 错误分类（`error.ts`）

`AgentErrorCode` 9 值，每个值都写了 UI 含义：

| code | UI 含义 |
|---|---|
| `auth` | 凭证无效 → 跳设置页 |
| `rate_limit` | 显示重试倒计时（`retryAfterMs`） |
| `context_length` | 提示 /compact |
| `network` | 可重试 |
| `aborted` | 用户主动中断，**不是错误，不弹提示** |
| `tool_failed` | ★ 进转录并继续循环，不终止 run |
| `provider` | 上游返回无法归一化的东西 |
| `no_healthy_provider` | 别名下全不健康 |
| `unknown` | 兜底 |

`FATAL_ERROR_CODES = ['auth','no_healthy_provider']`（`:40`）—— 只有这两类终止整个 run。`agentError()` 工厂默认 `retryable = code === 'network' || 'rate_limit'`。

### 3.4 RunRequest 与权限/交互

- ★ **runId 由渲染层 mint（ULID）**（`run-request.ts:2-7`）：订阅在前、启动在后。若由 `agent:run` 返回，invoke promise resolve 前内核已吐了三个事件，而渲染层还不知道 runId。
- 12 字段（`:82-105`）：`runId/sessionId/workspaceId/parentRunId?/depth/input: ContentPart[]`（空数组 = 续跑）`/mode/thinking/webSearch/permissionMode/model/skillIds`。★ `permissionMode` 是**快照**：run 开始时定死，运行期不变（界面文案「下一次新回复生效」）。`model` 是 `ModelAlias.alias`，不是上游真实模型名。
- ★ **会话模式落在工具层，不靠提示词祈祷**（`:13-18`）：plan → `snapshot({readOnlyOnly:true})` 过滤写工具 + 提示词追加；goal → `MAX_TURNS_GOAL=60`（normal 25）+ 禁止提前退出。`MAX_DEPTH=2`：「没有深度上限的子代理会指数级烧钱」。
- `ThinkingLevel` 8 档 + `THINKING_BUDGET` 表（minimal 1024 … max 64_000）；`auto` ≠ `off`（auto 取 medium 10_000）。
- `PermissionMode`：`ask/auto/full`（`:9-15`）。★ 决策类型必须是 union（`allow_once/allow_always{scope}/deny{reason}/allow_edited{input}`，后两者 v1 只定义不实现）——「以后都允许」和「让我改一下这条命令」是一周内必然提的两个需求。★ **子代理档位取 min(父, 子配置)**（`:57-61`）：否则被投毒的 MCP 工具描述可以诱导主 agent 派子 agent 去做它自己不被允许的事 —— 真实的提权路径。
- `PendingInteraction` 三变体统一一个机制（`interaction.ts`）：`tool_permission` / `ask_user` / `plan_approval`。★ **待决状态必须是可查询的持久状态，不能只是一个挂着的 Promise**（`:57-64`）：渲染层重载/崩溃 → promise 永不 settle → run 无声挂死。所以 `RunSnapshot.pendingInteractions` + `agent:listInteractions`。三类通知音效挂 `INTERACTION_SOUND`。

### 3.5 工具模型（`tool.ts`）与转录 reducer（`transcript.ts`）

- ★ **一个对象两个名字**（`:26-32`）：`internalId`（规范名，不限长，如 `mcp__github-enterprise__create_pr_review_comment`）+ `externalName`（模型看到的，必须过 `^[a-zA-Z0-9_-]{1,64}$` —— 超 64 换来一个什么都没说清的 400）。映射在一次会话内必须稳定：已落盘的转录存的是旧名字。
- ★ MCP/Skill 提供的**工具名与描述是不可信输入**，会进系统提示词 —— 工具投毒的入口；注册时必须字符白名单 + 限长。
- `ToolProgress` 是**易失的**：单独事件类型，永不写入转录。
- `transcript.ts` 的 `applyEvent(s, e)` 是「事件流 → 可渲染转录」的**纯 reducer**（UI 轨）。放在 shared 而不是 renderer 的理由（`:2-12`）：它最容易出的 bug —— 块按 index 错位、提交后残留活跃块、工具状态没归位 —— 表现为「偶尔串行/少一段」，盯屏幕复现不了，无头测试三行锁死。★ 假设输入有序且恰好一次（seq 已保证），不对重复/乱序免疫。
  - 逐事件行为表见 [08 渲染层 §3.4](./08-renderer.md)。
  - ★ `message_commit` → **提交即清空活跃块**：漏掉这句，已提交内容和活跃块同时显示 —— 全文重影。
  - ★ `hasRun(s, running)` 要两个入参：`emptyTranscript().status === 'running'` 是为「run 已起、事件未到」准备的，但全新空会话同初值；分辨信息在「有没有 activeRunId」，不在转录里（`RunStatus` 没有 idle 档，也不该加 —— 那是主进程 RunRegistry 的状态机）。

### 3.6 ULID（`util/id.ts`）

不是 UUID v4 的理由：**按时间字典序排序** —— SQLite 主键不随机写、`ORDER BY id` 即时间序。同毫秒单调靠 `bumpRandom` 递增随机段；渲染层用它 mint runId（「订阅在前」的前提）。`prefixedId(prefix)` 给调试用（`ws_01J8…`）。

## 4. Domain 子域（`shared/domain/*`）

| 文件 | 核心内容 |
|---|---|
| `settings.ts` | `AppSettings` 8 字段（theme/locale/defaultPermissionMode/defaultModel/subagent/gateway/notifications/proxy）。★ `AppSettingsPatch` 顶层标量整给、嵌套块只给要改的属性 —— 消灭一整类竞态：旧契约浅合并时连点两个同块开关，第二次写会把第一次的值用**旧的 prop** 覆盖回去，表现是「我明明打开了，它自己关了」（`:62-74`）。`mergeSettings` 纯函数、只深一层（AppSettings 只有两层）。`gateway.enabled` 默认 **false**；`preferredPort: 19836` 存的是**期望**端口 |
| `provider.ts` | ★ **别名表是故障切换的前提**：同一 alias 可由多个 provider 提供。`UpstreamProvider.credentialRef` 是 safeStorage 引用永非明文。`ModelAlias.alias ↔ upstreamModel` 分离。`ProviderHealth{score,consecutiveFailures,cooldownUntil,…}`。★ `GatewayStatus.host` 恒 `'127.0.0.1'`（不是 0.0.0.0 也不写 localhost）；旁路开关落在**路由器**不落 HTTP 壳 |
| `session.ts` | `Session.rootPathAtCreation` ★ 冻结工作区根：重新指向工作区不会追溯性改变旧工具调用的含义。★ `status` 只有 idle/running 且**永不恢复运行中状态** —— 启动时一律 idle，不必构建并不需要的崩溃恢复机制。`running` 角标数据源是 RunRegistry 不是 UI |
| `tab.ts` | ★ 双层模型：外层 `OuterTab`（workspace / feature 两类）、内层 `InnerTab` 7 kind（chat/terminal/doc/draw/browser/preview/files）。试金石：「关掉最后一个正在看运行中会话的 Tab，run 依然活着，外层 Tab 上显示角标」。★ **内层 Tab 属于工作区不属于窗口**；会话不是 Tab，Tab 只引用 sessionId。★ **三条 Tab 条（主区/底部/右侧）共用一张表**靠 `pane` 字段区分，`pane` 可选是为兼容旧落盘记录。★ macOS `hiddenInset` 让外层 Tab 条落在 `-webkit-app-region: drag` 区：OS 吞掉该区 pointer 事件，每个 Tab 必须 `app-no-drag`。`reorder` / `reorderInPane`（from/to 是**该格内**下标）纯函数两进程共用 |
| `terminal.ts` | 环形缓冲 256KB（否则切走再回来 xterm 重挂历史全没）、输出合批 16ms + 单批上限 64KB（一条 `yes` 能每秒上万行） |
| `mcp.ts` | stdio / streamable-http 双 transport；★ `MCP_SERVER_ID_RE` 白名单 —— serverId 会进工具名；`mcpInternalId()` 生成 `mcp__<serverId>__<tool>` |
| `skill.ts` | Anthropic 风格 Agent Skills：`/name` 调用、按工作区软链启用（全局开关 × 工作区激活双闸）。★ **Skill 正文是不可信输入**（zip/git 装的），与 MCP 同等对待；`SKILL_BODY_MAX = 64KB`。SkillRegistry 唯一下游是 ContextAssembler |
| `workspace.ts` | ★ **工作区（记录）≠ 外层 Tab（视图）**：Workspace 是持久实体，开没开、顺序、激活是窗口状态。`WorkspaceSettings`（permissionMode/defaultModel/defaultMode/defaultThinking/webSearch/activeSkillIds），`webSearch` 默认 **false** |
| `bootstrap.ts` | 首屏握手载荷：windowKind/settings/resolvedTheme/workspaces/tabState/activeRuns/versions —— 一次拿全，避免「设置到了但工作区还没到」的中间态 |
| `file-tree.ts` | `DirListing` 懒加载一层、`DIR_LISTING_LIMIT=2000` 带 `truncated` 标志、`sortEntries` 目录永远在前 |
| `greeting.ts` | 空会话首屏的分时段问候语 |

## 5. 不变量速查（★ 摘录，出处见上文行号）

1. 异常绝不穿过 `ipcMain.handle`；错误分类只有一处（`error.ts`）。
2. seq 在信封上、批内连续、只反推一次；重放不跑 gap 检查。
3. runId 渲染层 mint；订阅在前、启动在后。
4. 工具结果 = user 消息（Anthropic 形状）；每个 tool_use 必有配对 tool_result（两个方向都是 400）。
5. opaque 只搬运不解释；index 永远跟着块走。
6. 错误 code 是 UI 决策唯一依据；`tool_failed` 进转录继续循环。
7. 权限档位是 run 快照；子代理取 min 不继承 full。
8. 待决交互是持久状态不是 Promise。
9. 双名映射会话内稳定；MCP/Skill 文本是投毒入口，注册表收口消毒。
10. 双层 Tab + pane 三格一表；工作区记录 ≠ Tab；会话不是 Tab。
11. AppSettingsPatch 深合并消灭 prop 过期竞态。
12. ULID：时序数据用有序 id。
