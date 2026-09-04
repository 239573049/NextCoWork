# 09 · 工程化：构建、脚本、测试与质量基建

## 1. npm 脚本（`package.json`）

```bash
dev      electron-vite dev --watch
start    electron-vite preview
build    npm run typecheck && electron-vite build     # typecheck 前置 —— 「契约缺 handler 编译不过」的执行入口
lint     eslint .
test     vitest run        # test:watch: vitest
e2e      npm run build && node scripts/e2e-probe.mjs
shot     npm run build && node scripts/screenshot.mjs
review   node scripts/inline-shots.mjs docs/design-review.standalone.html
dist     npm run build && electron-builder        # dist:dir 只打目录
postinstall  electron-builder install-app-deps    # 原生模块按 Electron ABI 重建
```

`dependencies` 只有 5 个：`@electron-toolkit/preload`、`@electron-toolkit/utils`、`@modelcontextprotocol/sdk`、`node-pty`、`zod`。engines `^20.19.0 || >=22.12.0`。

## 2. `electron.vite.config.ts` —— 三个非显然的配置

### 2.1 `shimNonTtyCursor()`（`:17-23`）

electron-vite 5 的 `vite:isolate-entries` 插件在 stdout **不是 TTY** 时崩：它无条件调 `process.stdout.moveCursor()` 擦一行进度。CI、`npm run e2e`、任何把输出重定向到文件的调用都会挂在 `process.stdout.moveCursor is not a function` 上 —— **报错文案完全不提 TTY**，看起来像 preload 打包坏了。补 `moveCursor/clearLine/cursorTo` 三个空实现，只在缺席时定义（真 TTY 下行为一个字节没变）。「这比在每个调用点套 `script -q /dev/null` 伪终端可靠：忘一次就是一次假失败。」

### 2.2 `cspDevPlugin()`（`:32-54`）

`index.html` 写死的是**生产严格 CSP**；dev 下 react-refresh 注入内联 script、HMR 要连 `ws://localhost`。dev 时**整段替换**成放宽版而非注入 —— 「插件哪天没生效，留在页面里的就是严格版，失败方向朝安全那边倒。」

### 2.3 preload 构建（`:72-87`）

★ `isolatedEntries: true` + `externalizeDeps: false`：「沙箱化 preload 无法 require 多文件，必须完整打包成单文件」（因果链见 [07 篇 §3](./07-preload.md)）。alias 只有 `@shared`（preload 不该碰 main）。main 侧 `externalizeDepsPlugin()` 把 dependencies 全部 external（运行时从 node_modules require）。

renderer：react + tailwindcss + cspDevPlugin，alias `@shared`/`@renderer`。

## 3. `electron-builder.yml`

- ★ **`asarUnpack: ['**/node_modules/node-pty/**', 'resources/**']`**：node-pty 在 macOS 依赖 spawn-helper 可执行文件、Windows 依赖 conpty.dll —— asar 内的二进制无法 exec，「不 unpack 就是『dev 好好的，打包后开终端报错』」。
- `npmRebuild: true`：原生模块按 Electron ABI 重建（`postinstall` 同理）。
- **electronFuses**：`runAsNode:false`、`enableNodeOptionsEnvironmentVariable:false`、`enableNodeCliInspectArguments:false`（收掉三条把进程当 Node 跑的逃逸口）、`enableCookieEncryption:true`；`enableEmbeddedAsarIntegrityValidation` 与 `onlyLoadAppFromAsar` **刻意 false** —— 「需要正确的代码签名才能生效；未签名的本地构建会直接崩在完整性校验上。正式发布（配好签名）时打开。」
- 产物：mac dmg+zip / win nsis / linux AppImage。

## 4. `.npmrc` —— 二进制镜像

```
electron_mirror=https://cdn.npmmirror.com/binaries/electron/
electron_builder_binaries_mirror=https://cdn.npmmirror.com/binaries/electron-builder-binaries/
```

本机网络无法访问 github.com 的 release 下载（curl 超时）而 registry.npmjs.org 正常 —— **只有二进制下载需要走镜像**。electron 与 electron-builder 都经 `@electron/get` 下载二进制，它读 npm config 的 `electron_mirror`；不配这行，`npm install` 以 `TypeError: fetch failed` 结束且 `node_modules/electron/dist` 为空（npm 会对「Unknown project config」发 warn，可忽略）。

## 5. 测试基建

### 5.1 vitest（`vitest.config.ts`，17 行）

```ts
test: { environment: 'node', include: ['src/**/*.test.ts'] }
```

- **刻意不复用 electron.vite.config**：要测的东西按设计就该在普通 Node 里跑 —— `src/shared/**` 是纯类型纯函数，`src/main/kernel/**` 与 `runtime.ts` 零 electron import。
- ★ 文件头是一条**架构报警器**：「哪天某个测试因为找不到 electron 挂了，那不是配置问题 —— 是有人把 electron 依赖漏进内核了，这个测试就是报警器。」
- 覆盖：shared 4、kernel 12、ipc 3、state 1、renderer 9 ≈ 29 个文件。Electron 相关层（真 webContents、真 preload 白名单、真打包产物）**不被 vitest 覆盖** —— 那正是 e2e 探针存在的理由。

### 5.2 双 tsconfig

| | `tsconfig.node.json` | `tsconfig.web.json` |
|---|---|---|
| include | `electron.vite.config.ts`、`src/main/**`、`src/preload/**`、`src/shared/**` | `src/renderer/src/**`、`src/shared/**`、**`src/preload/*.d.ts`** |
| types | `electron-vite/node`, `node` | 无 |
| paths | `@shared/*`, `@main/*` | `@shared/*`, `@renderer/*` |

为何分开：① 依赖方向相反的两套 lib（Web 侧混入 node types 会让 `process`/`Buffer` 在渲染层被当成存在）；② **`src/shared/**` 两边都进** —— shared 必须同时能被两侧编译，等于双向约束；③ preload 的**实现**（index.ts，要 import electron）与**声明**（index.d.ts，补 `Window`）分属两侧 —— 这是 `index.d.ts` 类型跨到渲染层的唯一机制。共同 strict 套件：`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`。

### 5.3 eslint（`eslint.config.mjs`，34 行）

基座 `js.configs.recommended + tseslint.configs.recommended`；`no-unused-vars`/`no-explicit-any` 降为 warn（`^_` 忽略）。★ 专门给 `scripts/**/*.mjs` 的 override 手工列了 6 个全局（`process/console/fetch/WebSocket/JSON/Buffer`）—— scripts 不在任何 tsconfig include 里，`no-undef` 会真的生效；「这里要的就这几个，列出来比多一个依赖清楚」（不引 `globals` 包）。

## 6. `scripts/` 工具箱

### 6.1 `e2e-probe.mjs`（257 行）—— 端到端冒烟

无头 Electron（`--remote-debugging-port=9333` + 临时 userData），自写 60 行 CDP 客户端（`Runtime.evaluate` + `returnByValue` + `awaitPromise`），五步断言：`window.nextcowork` 存在（沙箱下单文件 preload 通了）→ composer 存在 → 发送按钮 title 是 `nextcowork-demo`（bootstrap 带回默认模型）→ React 受控输入 + 点发送（走原型 setter + input 事件）→ 等流式文字 → 读 `chat-status` 的 `data-*` 断言 `status==='done'`、`seq>=1`、全部工具 ok、`model==='demo-model'`。★ e2e 读 `data-testid`/`data-*` 不正则中文文案 —— 「改文案会莫名其妙挂掉 e2e」。开头清掉 `ELECTRON_RUN_AS_NODE`（否则 Electron 直接当 Node 跑，无窗）。

### 6.2 `screenshot.mjs`（200 行）

CDP + `Page.captureScreenshot`，5 张（empty/typed/streaming/done/collapsed），VIEWPORT 1264×1141。★ 记录了一个真实踩坑：视口大于真窗口时，`captureBeyondViewport` 会把窗口外填成上一帧残留，产出自叠加图，**看起来像「布局重复渲染」的 UI bug**。

### 6.3 `inline-shots.mjs` / `pick-color.mjs` / `crop.mjs` / `.scan-tmp.mjs`

- `inline-shots`：把 design-review.html 里的 `shots/*.png` 换成 base64 data URI，产出自包含单文件。
- `pick-color` / `crop`：**零依赖手写 PNG 解码/编码器**（8bit RGB/RGBA、全部 5 种 filter 反滤波）。用于从参考截图量设计 token（theme.css 的数值都是这么来的）——「改这个数之前先去量图，别凭手感」（AppShell 注释）。
- `.scan-tmp.mjs`：隐藏临时工具，输出指定行/列上的连续同色段，量边距/分隔线位置。

### 6.4 `mutate-*.py` —— 变异测试（falsification）

三个**手写变异测试**框架：对源码做**精确字符串替换**（每个模式必须恰好出现 1 次，否则记「变异定义失效」计失败）→ 跑目标测试 → returncode 0 = **变异体存活 ❌**（说明该设计决策没有测试撑腰）≠ 0 = **被杀 ✅**。`finally` 一律还原备份。合计 **73 个变异体**。

| 脚本 | 目标测试 | 变异 | 被测文件 |
|---|---|---|---|
| `mutate-agent-session.py` | kernel/agent-session.test.ts | 27（M1–M27） | `agent-session.ts` —— 27 条注释里声称「不能省」的设计决策（中断补偿、半截回复提交、plan 过滤写工具、`sawContent` 边界…） |
| `mutate-demo-upstream.py` | upstream/demo.test.ts | 32（D1–D29+X1–X3） | `demo.ts/sse.ts/decode/encode` —— X1–X3 落在**链路上别的文件**（TextDecoder stream 标志、signature 累加、max_tokens 抬高），证明 demo.test 是**链路回归网**而不只是 demo 的镜子 |
| `mutate-wiring.py` | agent-run + agent-pump + store 三份**一起跑** | 14（W1–W14） | `ipc/agent.ts/runtime.ts/store.ts` —— 变异几乎全是**少接一根线**（默认驱动没换、先启动后订阅、runtime 四单例漏装、store 三不变式） |

★ 方法论坑（`mutate-wiring.py:22-25`）：「变异测试报出存活，第一件事永远是先确认能杀它的那份测试真的在这一轮里跑了」—— 所以 store.test.ts 必须拉进来，否则 W12–W14 会假存活。三个脚本都不在 package.json，手工 `python3 scripts/mutate-*.py`；都显式清 `ELECTRON_RUN_AS_NODE`。

## 7. 质量策略小结

这套仓库的质量体系是**四层漏斗**，每层只管自己那一段：

1. **编译期哨兵**：契约↔白名单双向 `satisfies`、`HandlerMap` 完备映射、`PATCHABLE_KEYS`、`INNER_VIEW_KINDS`、`Record<Brand,string>` —— 「漏一个就编译不过」。
2. **无头单测**：靠「kernel/runtime/shared 零 electron」跑普通 Node；纯函数（transcript reducer、block-accumulator、encode/decode）直接锁行为。
3. **整链验收**：`agent-run.test.ts` + `demo.test.ts` 的 AgentSession 验收段 —— 零 mock 零打桩，「唯一不真的东西是那根网线」。
4. **变异测试 + CDP e2e**：变异测试回答「这些设计决策是否真的有测试撑腰」；e2e 回答「Electron 那一层（sandbox、preload 单文件、结构化克隆、真 IPC）是否真的接对了」—— vitest 唯一覆盖不到的正是这一层。

## 8. 协议文档 vs 实现核对表（完整版）

`docs/ipc-protocol.md` / `model-gateway-protocol.md` / `agent-request-flow.md` 三份文档是协议层/目标态，`contract.ts:5-13` 明写「照单全收 + 四处收紧」。逐条核对（按重要性）：

**形状性差异（文档已被实现有意收紧）**

| 文档 | 代码 | 判定 |
|---|---|---|
| `window.newmax.*`，每频道一个方法 | `window.nextcowork`，通用三元组 invoke/send/on + 运行时白名单 | 命名与形状不同；防线从「封装位置」换成「运行时白名单」，强度相当 |
| 两种返回风格、异常穿 handle | 单一 `IpcResult` 信封、异常绝不穿 handle | 收紧，文档过时 |
| 长任务 invoke 返回 taskId + progress 事件 + cancel | runId 由调用方传入；单一 `agent:event` 信封带 seq；`agent:attach(sinceSeq)` 重放；`agent:abort{runId,cascade}` | 收紧，文档过时 |
| `agent:chunk/contextUsage/cancel/reset/endSession` 等多频道 | 合并为 `agent:event` + `agent:abort`；`contextUsage` 变成事件类型 `context_usage`（`event.ts:24` 注释明写「抄自 agent-request-flow.md §4」） | 命名不同 |
| 三套审批频道（tool-approval/ask-user/plan） | 统一 `agent:respondInteraction` / `agent:listInteractions` / `RunSnapshot.pendingInteractions` | 命名不同 |
| 频道命名 `模块:动作`、on 返回退订 | 一致（无三段式 `a:b:c`） | 一致 |

**架构性差异（文档描述的是未实现的形态）**

| 文档 | 代码 | 判定 |
|---|---|---|
| 本地 HTTP 网关 `127.0.0.1:19836`，`/v1/messages` 等端点、鉴权、404 自描述 | **无任何 HTTP 服务**（grep `createServer/.listen(` 零命中）；19836 只是 `gateway.preferredPort` 期望值（默认 disabled）；治理逻辑在进程内 `UpstreamRouter`，HTTP 壳是步骤 13 | 不存在 |
| 推理引擎 = 主进程 spawn 的子进程、`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` 环境变量 | Agent 循环在主进程内（无 child_process）；key 经 `encodeAnthropic` 注入 headers；`ANTHROPIC_*` 字符串零命中 | 架构性差异（最大的一条） |
| Base URL 会话映射 `/s/<sessionId>`、网关开关切换直连/代理 | 开关是进程内路由模式（`failoverEnabled()` → 候选集切片/健康排序）；URL 两种模式下相同 | 概念保留，机制不同 |
| 3×3=9 组协议转换、`useResponsesApi` | 只实现 anthropic→anthropic；其余返回明确的「步骤 13 未实现」 | 1/9 |
| DashScope compatible-mode 等 URL 特例 | 只有 `joinUpstreamUrl` 启发式 + 「设置页必须显示最终 URL」的要求 | 特例缺失 |
| `terminal:exists`、`storage:readFileBase64` 等二进制频道、`appWindow:*`/`quickWindow:*`/`auth:state-changed` | 契约中不存在；`auth` 只是 AgentErrorCode | 未纳入契约 |
| 终端模块目录（create/kill/list/getBuffer/write/resize/data/exit） | 契约完全一致，但 handler 全部 `todo()`（步骤 8）、send handler 空函数体、事件无发射器、node-pty 未 import | 契约一致，实现全空 |
| `browser:*`、`voice*`、`hermes:*`、`im:*`、`wallet:*`、`scheduledTasks:*` 等模块 | 源码零命中（部分以 `FeatureKind`/`StubPage` 占位并直说被砍） | 不存在 |

**判定口诀**：三份文档描述的是**协议与目标态**；读实现以 `docs/modules/` 为准，读意图（为什么这么设计）以 `contract.ts` 文件头与各源码注释为准。
