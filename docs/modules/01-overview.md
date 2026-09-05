# 01 · 架构总览

> 本文是模块文档的入口。描述 NextCoWork **当前代码**的实际架构 —— 不是设计文档里的目标态。
> 术语与细节在各模块文档中展开：[02 共享契约层](./02-shared-contract.md) · [03 Agent 内核](./03-kernel.md) · [04 工具子系统](./04-kernel-tool.md) · [05 上游子系统](./05-kernel-upstream.md) · [06 主进程外壳](./06-main-process.md) · [07 preload 桥](./07-preload.md) · [08 渲染层](./08-renderer.md) · [09 工程化](./09-engineering.md)

## 1. 项目定位

**NextCoWork —— 编码型 Agent 桌面端**（`package.json:4`）。Electron 桌面应用：用户把一个本地目录作为「工作区」打开，在里面与一个能调用工具的 LLM Agent 对话；Agent 循环运行在**主进程**内，流式结果经 IPC 回填 UI。

技术栈：

| 层 | 技术 |
|---|---|
| 外壳 | Electron 44 · electron-vite 5 · electron-builder 26 |
| 渲染层 | React 19 · TypeScript 5.9（strict + `noUncheckedIndexedAccess`）· Tailwind CSS v4 · zustand 5 |
| 内核（主进程） | 纯 TS，**零 electron import**（见 §3）· zod（工具 schema） |
| 终端（规划） | node-pty（唯一原生依赖，当前未接线） |
| 存储（规划） | Node 内置 `node:sqlite`（启动探针 `src/main/db/probe.ts` 验证 fts5/json1/rtree），当前是内存实现 |
| 测试 | vitest（`environment: 'node'`，29 个测试文件）+ 3 个手写变异测试脚本（73 个变异体）+ CDP 端到端探针 |

## 2. 三层结构与依赖方向

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染进程 src/renderer     React 19，纯 IPC 客户端              │
│   不持有 Node / 网络 / 凭证能力；不做任何模型 HTTP 调用           │
└───────────────▲──────────────────────────────────────────────┘
                │ window.nextcowork.{invoke,send,on}   ← contextBridge
┌───────────────┴──────────────────────────────────────────────┐
│ preload src/preload     安全边界（sandbox: true 单文件打包）    │
│   运行时频道白名单校验；不转发 IpcRendererEvent                  │
└───────────────▲──────────────────────────────────────────────┘
                │ ipcMain.handle / on  ←→  emitToTopic / emitToAll
┌───────────────┴──────────────────────────────────────────────┐
│ 主进程 src/main                                                │
│   index.ts / host/ / ipc/ / window/ / db/     ←─ 唯一允许       │
│   runtime.ts（装配，零 electron import）        import electron │
│   kernel/  Agent 内核：session · run-registry ·                │
│            context-assembler · block-accumulator · tool/ ·     │
│            upstream/ · abort · text        ←─ 零 electron       │
└──────────────────────────────────────────────────────────────┘
```

**四条依赖方向铁律**（每条都有测试执法）：

1. `src/shared/**` 对外依赖为零（纯类型 + 纯函数），三方共用；内部 `ipc → domain → agent` 单向下探，绝不反向。
2. `src/main/kernel/**` 零 electron import —— 换来的是全部内核单测跑在普通 Node 的 vitest 里（`vitest.config.ts:8-10` 明言：哪个测试因「找不到 electron」挂了，就是有人把 electron 漏进内核，**那是报警器**）。
3. `src/main/runtime.ts` 同样零 electron import（`runtime.ts:4-10`）—— 否则 `ipc/agent.ts` 的整条 import 链会把 electron 拖进来，`agent-pump.test.ts` / `agent-run.test.ts` 就没法无头跑。
4. electron 的**值**导入只存在于 `src/main/index.ts` 与 `src/main/host/index.ts`（窗口/生命周期/safeStorage/net.fetch）。

## 3. 进程模型：Agent 循环在主进程内

一个必须先澄清的事实：`docs/agent-request-flow.md` 与 `docs/README.md` 把执行体描述为「主进程 spawn 的**推理引擎子进程**」，并把模型调用描述为经本地 HTTP 网关（`127.0.0.1:19836`）。**当前代码不是这样**：

- `src/` 下没有任何 `child_process` / `node:http` / `.listen(`（grep 零命中）；
- Agent 循环 = `AgentSession`（`kernel/agent-session.ts`），由 `runAgent()`（`runtime.ts:192-223`）驱动，作为 `ipc/agent.ts` 的默认 `RunDriver` 在**主进程内**运行；
- 「网关」目前是进程内纯模块 `UpstreamRouter`（`kernel/upstream/router.ts`）—— 归一化、健康评分、故障切换都在，HTTP 协议壳（步骤 13）未建；`19836` 只是设置里的**期望端口**，`settings.gateway.enabled` 默认 false。

方向性的两条约定仍然成立：渲染层是纯 IPC 客户端；模型调用经 `KernelHost.fetch`（Electron 侧注入 `net.fetch`，走 Chromium 网络栈，系统代理/企业证书/设置页代理因此生效）。

## 4. 目录地图

```
src/
├─ shared/                    契约层（02 篇）
│  ├─ agent/                  Agent 领域词汇：event/message/stream/tool/error/
│  │                          permission/interaction/run-request/transcript
│  ├─ domain/                 聚合/配置：settings/provider/session/tab/terminal/
│  │                          mcp/skill/workspace/bootstrap/file-tree/greeting
│  ├─ ipc/contract.ts         类型化 IPC 契约：62 频道三张表 + 白名单
│  └─ util/id.ts              ULID（单调）与 prefixedId
├─ main/                      主进程（03/04/05/06 篇）
│  ├─ index.ts                入口：单实例锁/启动时序/建窗
│  ├─ runtime.ts              装配：host + router + tools + seed + runAgent
│  ├─ host/index.ts           electronHost()：paths/secrets/fetch 三覆盖 + 演示上游
│  ├─ kernel/                 Agent 内核（零 electron）
│  │  ├─ agent-session.ts     think → tool → observe 循环
│  │  ├─ run-registry.ts      run 登记/多消费者/重放/级联中止
│  │  ├─ context-assembler.ts 系统提示词 + token 估算 + 压缩
│  │  ├─ block-accumulator.ts 增量流 → ContentPart[]
│  │  ├─ tool/                工具框架（define/naming/registry/path-guard/builtin）
│  │  └─ upstream/            上游治理（canonical/router/sse/encode/decode/demo）
│  ├─ ipc/                    频道 handler：index/agent/app/settings/workspace/
│  │                          provider/errors + 合批泵
│  ├─ state/store.ts          内存状态仓（步骤 6 将整体换 SQLite）
│  ├─ window/registry.ts      定向事件推送（绝不广播）
│  └─ db/probe.ts             node:sqlite 能力探针
├─ preload/index.ts(+d.ts)    安全桥（07 篇）
└─ renderer/src/              渲染层（08 篇）
   ├─ App.tsx / main.tsx      握手 + 全局订阅 + 事件泵启动
   ├─ services/               桥封装：ipc(拆信封)/app/agent/provider
   ├─ stores/                 zustand：window/tabs/session/models + runIndex + 事件泵
   ├─ shell/                  AppShell/侧边栏/双层 Tab 条/面板/拖拽重排
   ├─ views/                  registry.tsx 视图分发 + chat/ + files/
   ├─ components/             ui/ 基础控件 + brand/ 供应商图标
   ├─ settings/               设置页数据与排版（浮层容器待接）
   └─ styles/theme.css        设计 token（截图采样）
```

## 5. 启动时序（`src/main/index.ts`）

```
模块顶层（app ready 之前）
  1. requestSingleInstanceLock()      :18  失败即 quit —— 两实例开同一 SQLite 会打架
  2. dev 下 userData 加 -dev 后缀      :25  开发不污染真实数据
whenReady 之后
  3. logStartupProbe()                :104  异步不阻塞：node:sqlite / fts5 / json1 / rtree
  4. initRuntime(electronHost())      :113  ★ 必须先于 registerIpc —— bootstrap 要带
  5. registerIpc()                    :117  ★ 必须先于建窗 —— 第一个 invoke 可能早于窗口 show
  6. createMainWindow()               :119  ★ windows.register 先于 loadURL —— kind 判定要准
  7. before-quit                      :142  flushPendingPersists() + shutdownRuns()
```

四条顺序约束的完整依据见 [06 主进程外壳 §1](./06-main-process.md)。

## 6. 一次 run 的全链路（端到端）

```
渲染层                                   主进程
────────                                ────────────────────────────────────────────
ulid() mint runId                        startRun (ipc/agent.ts:114-129)
registerRun(runId → sessionId)   ──┐       ├─ windows.subscribe(run:topic)      ① 订阅在前
send('agent:run', RunRequest)    ──┴──▶    ├─ runs.create(req) → RunHandle
                                           ├─ pumps.set(new RunPump(handle))    合批泵
                                           └─ runAgent(handle, req)             ② 启动在后
                                                └─ new AgentSession(...)
                                                     构造器 commit(用户消息)          首个 message_commit
                                                     run() 不抛异常
                                                      每轮 turn():
                                                        tools.snapshot(plan 过滤)
                                                        assemble() → context_usage 请求前发
                                                        upstream.stream(CanonicalRequest)
                                                          UpstreamRouter: 候选集→健康→冷却
                                                            encodeAnthropic → host.fetch
                                                            sseFromResponse → decodeAnthropic
                                                        BlockAccumulator.apply(逐事件)
                                                        commit(assistant)             落盘边界
                                                        executeAll(并行) → tool_result
on('agent:event')  ◀── RunPump 合批发信封  ◀── handle.emit（seq 单调）
  hasSeqGap? → attachRun 重放
  rAF 再缓冲 → applyEnvelope
    transcript reducer（applyEvent）─▶ Thread/Composer/StatusLine 渲染
```

关键不变量（细节在对应篇目）：

- **订阅在前、启动在后**（方案 §3 规则 2）：runId 由渲染层 mint，这个顺序才成立；事件不会丢在「还不知道 runId」的窗口里。
- **seq 放在信封上**、批内连续、`envelopeFirstSeq()` 反推；缺口/重复一律走 `agent:attach` 幂等重放。
- **合批双层**：主进程 16ms / 64 条（只攒三种 delta，结构性事件立即 flush）→ 渲染层 rAF 对齐帧。
- **run 结局一律经 `handle.finish`**，`AgentSession.run()` 不抛异常；中断走「方案 §4.8 五件事」的分工（[03 篇 §3.5](./03-kernel.md)）。

## 7. 实现状态总表（以代码为准）

契约登记 62 条频道 = invoke 47 + send 5 + event 10（`shared/ipc/contract.ts:91-230`）。截至本文写作：

| 状态 | 频道 | 说明 |
|---|---|---|
| ✅ 已实现 invoke（16） | `app:getBootstrap/openExternal`、`settings:get/update`、`workspace:list/pick/update/close/listDir`、`tabs:getInner`、`agent:run/attach/abort`、`provider:list/listModels` | provider 只读两条先行，因为它们是模型选择器的唯一数据源 |
| ✅ 已实现 send（3） | `window:ready`、`tabs:persistOuter/Inner` | `terminal:write/resize` 是空函数体（`ipc/index.ts:164-165`）—— 终端按键当前被静默丢弃 |
| ✅ 有发射点的 event（4/10） | `agent:event`、`settings:changed`、`theme:changed`、`workspace:changed` | 订阅其余 6 条（`terminal:data/exit`、`gateway:status/failover`、`skills:changed`、`mcp:changed`）永远收不到回调 |
| ⏳ 契约已定、handler 是 `todo()`（27） | sessions×7、`conversations:searchAll`、storage×2（步骤 6）；agent:respondInteraction/listInteractions（步骤 5）、agent:listTools（步骤 4）；terminal×4（步骤 8）；mcp×4（步骤 10）；skills×3（步骤 12）；provider 写入面×5（步骤 4）；gateway×3（步骤 13） | `NotImplementedError` 带步骤号，见 `ipc/index.ts:57-119` |
| ⚠️ 已写内核、缺外壳 | `UpstreamRouter.resetHealth()` 无调用方；failover 事件无 emit 点；`electronSecrets()`（safeStorage）因 `provider:setCredential` 是 todo 而不可达，且密文 Map 仅内存不跨重启 | [06 篇 §9](./06-main-process.md) |
| ⚠️ 占位实现 | `state/store.ts` 全内存（**无任何磁盘持久化**，Tab 布局跨重启不恢复，只跨 ⌘R）；`workspaceRootFor` 用 `paths.temp()` 兜底（步骤 9 落地时必须改成拒绝） | [06 篇 §5](./06-main-process.md) |
| 🔨 接线中（写作时点） | 渲染层 `files` 内层 Tab：`views/files/FilesView.tsx` 已完成，`Panels.tsx`/`AppShell.tsx` 仍在替换 `WorkspaceFilesPanel`，`makeTab` 缺 `files` case，`tsc -p tsconfig.web.json` 当前 3 条错误 | [08 篇 §10](./08-renderer.md) |
| 🚫 方案 §10 明确砍掉 | 账户/钱包/云同步/每日回顾等商业化面；渲染层以 `StubPage` 直说，不写「即将推出」 | `settings/pages/StubPage.tsx` |

## 8. 内置演示上游的意义

`kernel/upstream/demo.ts`（642 行）是理解本仓库的关键：**真 SSE、假网络**，挂在 `KernelHost.fetch` 上按主机名 `demo.invalid` 分派（不是全局「演示模式」布尔）。它做两件假发射器永远不做的事：

1. **按字节切片不按事件切片** —— 一个中文字 3 字节必然被劈开，SSE 分块边界的 bug 每次 dev 都必然暴露；
2. **像真上游一样挑剔** —— 空 text 块、无签名 thinking、未配对 tool_result 一律 400，宽容的假上游会把错误藏到用户填真 key 那天。

因此「演示与真实之间没有一条分叉的代码路径」，消灭「dev 里好好的，填了真 key 就崩」。启动时演示 provider **总是进表**（priority 100 全表最低，`runtime.ts:67-74`），默认模型 seed 为 `nextcowork-demo`（已选过则不覆盖）。

## 9. 与既有三份协议文档的关系

`docs/ipc-protocol.md`、`docs/model-gateway-protocol.md`、`docs/agent-request-flow.md` 是**协议层/目标态**文档；`shared/ipc/contract.ts:5-13` 的文件头明写「照单全收 + 四处收紧」。主要差异速查（完整核对表见 [09 篇 §6](./09-engineering.md)）：

| 协议文档说 | 代码实际 |
|---|---|
| `window.newmax.*`，每频道一个方法 | **`window.nextcowork`**，通用三元组 `invoke/send/on` + 运行时白名单 |
| 本地 HTTP 网关 `127.0.0.1:19836` | 不存在；进程内 `UpstreamRouter`，`failover` 开关落在路由器 |
| 推理引擎是主进程 spawn 的子进程、`ANTHROPIC_BASE_URL` 环境变量 | Agent 循环在主进程内；key 经 `encodeAnthropic` 注入 headers |
| `agent:chunk` / `agent:contextUsage` / `agent:cancel` 等多频道 | 合并为单频道 `agent:event`（信封带 seq）+ `agent:abort`；`context_usage` 成为事件类型 |
| 三套审批频道（tool-approval/ask-user/plan） | 统一 `agent:respondInteraction`（三种 kind 共用） |
| 长任务无序号不可重放 | 信封带 seq，`agent:attach(runId, sinceSeq)` 幂等重放 |

## 10. 常用命令

```bash
npm run dev          # 开发（electron-vite dev --watch）
npm run typecheck    # node + web 两侧；「契约缺 handler 编译不过」的执行入口
npm test             # vitest run（无头，node 环境）
npm run e2e          # build + CDP 探针：桥→握手→发送→流式→工具→终态 全链路断言
npm run shot         # build + 5 张 UI 截图（/tmp/nextcowork-shots）
python3 scripts/mutate-agent-session.py    # 变异测试三件套（另见 09 篇）
```

环境陷阱：VSCode 终端若带 `ELECTRON_RUN_AS_NODE=1`，直接 `npm run dev` 会无窗启动 —— 用 `env -u ELECTRON_RUN_AS_NODE npm run dev`。`npm install` 依赖 `.npmrc` 的 npmmirror 二进制镜像（github.com release 不可达）。
