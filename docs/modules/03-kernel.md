# 03 · Agent 内核 `src/main/kernel`（核心层）

> 「我们自己拥有这个循环」的兑现处。约 1700 行换来权限过滤、会话模式、子代理、中断收尾都真的归我们管。
> **零 electron import、零时钟读取**（`now` 一律 `host.clock.now()`）—— 整个循环能在普通 vitest 里跑完，不启动 Electron、不联网、不看真时间。

| 文件 | 行 | 一句话 |
|---|---|---|
| `host.ts` | 115 | KernelHost：内核对外部世界的唯一开口 |
| `agent-session.ts` | 442 | think → tool → observe 主循环 |
| `run-registry.ts` | 309 | run 登记 / 多消费者 / 重放 / 级联中止 |
| `context-assembler.ts` | 388 | 系统提示词 + token 估算 + 机械压缩 |
| `block-accumulator.ts` | 188 | 增量流 → `ContentPart[]` |
| `abort.ts` / `text.ts` | 45/33 | 「是不是中断」「削哪些字符」只答一次 |
| `fake-emitter.ts` | 156 | 测试夹具（对 RunHandle 的用法与真 session 完全一致） |

## 1. KernelHost（`host.ts`）

### 1.1 端口全集（`host.ts:49-63`）

| 端口 | 类型 | 说明 |
|---|---|---|
| `paths` | `{userData(), temp()}` | 存储根与临时目录 |
| `secrets` | `{get(ref), set(ref,v), available()}` | ★ 只存引用，内核里永不出明文 key；`available()` 为 false 时调用方必须有明确降级路径（Linux 无 keyring） |
| `clock` | `{now()}` | 全内核唯一时钟来源 |
| `logger` | `Logger`（debug/info/warn/error） | |
| `fs` | `KernelFs`（readFile/writeFile/readDir/stat/realpath） | 步骤 9 的文件工具会实现；**所有路径必须先过 `resolveInWorkspace`** |
| `spawn` | `(cmd,{cwd,signal,timeoutMs?})→{code,stdout,stderr}` | ★ Agent 的 bash 工具**不复用**交互式 PTY：混用会让工具输出和用户敲的字交错，且拿不到干净 exit code |
| `fetch` | `typeof fetch` | 注入式网络：换 net.fetch 走代理 / 测试打桩 / 演示上游，三件事共用同一个口子 |

**没有** safeStorage 端口（safeStorage 只在 Electron 侧，内核拿到的只是「可用的 secrets 实现」），也没有 IPC/UI 端口 —— 内核根本不知道窗口的存在。

### 1.2 `nodeHost()`：真实默认值，不是测试替身（`host.ts:87-115`）

Electron 侧只覆盖 paths/secrets/fatch 三项（真正需要 Electron 的能力），其余端口「在 Electron 里和在 Node 里是同一件事，覆盖只会多一份要同步维护的代码」。于是无头测试跑的是**与 dev 完全同一条装配路径**，只是宿主换了一层皮（`runtime.ts:47-51`）。

★ `notYet(port, '步骤 N')`：未实施端口**抛错而非返回空值**（`host.ts:65-71`）—— 一个静默的空实现会让「步骤 9 还没做」表现成「工具读到了空文件」，那是最难查的一类 bug。当前 `fs` 五法与 `spawn` 均 notYet（步骤 9）。

### 1.3 Electron 侧实现（`src/main/host/index.ts`）

- `electronSecrets()`：safeStorage 加解密 + 进程内密文 Map；**落盘从头到尾都是 `encryptString` 的产物，明文一次都没离开这两个函数**；`isEncryptionAvailable()` 为 false 时**明确抛错**——「明文落盘不是可接受的降级」（静默丢弃也不行：设置页会显示已保存，重启却为空）。
- `fetch` 用 `net.fetch`（走 Chromium 网络栈：系统代理、企业证书、设置页「代理」才对模型请求生效），并适配其不收 `URL` 的窄签名。
- ★ `electronHost()` 要求 `app.isReady()` 否则抛错（`:62-68`）：早一步拿到的是「看起来正常、实际不可用的 host」，症状推迟到第一次发请求，错误信息里已没有「调早了」这条线索。
- 最外层包 `withDemo(...)`：`withDemoSecrets` 只劫持 `demo:api-key` 一个 ref；`withDemoUpstream` 按主机名分派 —— 真上游与演示上游同进程共存，没有全局「演示模式」布尔。

## 2. AgentSession（`agent-session.ts`）—— 主循环

### 2.1 顶层规则

- ★ `:10-11` **session 不重试、不做故障切换**（在 `UpstreamRouter`）：放在这里会重放已经执行过的工具调用 —— 一次「重试」把文件写两遍。
- ★ `:135-137` `run()` **不抛异常**：结局一律经 `handle.finish` 表达 —— 逃出去的异常会变成「run 无声消失」：UI 转圈不停，日志里只有一行栈。调用方因此**不 catch**（`runtime.ts:189-190`：真加一个 catch 反而会掩盖这个承诺哪天被破坏）。
- 接缝刻意收窄：`SessionUpstream` 只有 `stream()`/`listModels()` 两方法，**不写成 `UpstreamRouter` 类型**（`:43-50`）—— 单测传一个十几行的假上游就能跑完整个循环；`ApproveFn` 单对象入参（步骤 5 拼 `PendingInteraction` 不改调用方）；`approve`/`skills` 缺省（无 Skill、一律放行）就是此刻的正确行为，刻意不写占位实现。
- ★ `history` getter 只是 `this.messages`；**session 不负责持久化** —— 由调用方在 `.finally` 里落盘（`runtime.ts:214-222`），SQLite（步骤 6）接在这个缝上。

### 2.2 一次 run 的时序

```
runAgent (runtime.ts:192-223)
  └─ new AgentSession(deps, handle, req)
       └─ 构造器 commit(userMessage(input))     ★ 用户消息也要 emit —— 渲染层转录是事件流的投影，
                                                  没 commit 用户就看不到自己那句话、重载后还会出现双 id
  └─ session.run().finally(store.setHistory)     ★ finally 不是 then：中断路径上 finalizeAbort 已把
                                                  半截回复和补上的 tool_result 写进 history，不落盘
                                                  下一轮就带着孤儿 tool_use 上行 = 400
run() → loop() → turn() × maxTurns
```

- `maxTurns = maxTurnsFor(mode)`：goal 60 / 其余 25（`shared/agent/run-request.ts:108-115`）。★ 轮次耗尽**不伪造「我做完了」的助手消息**（`:167-175`）—— 那会让用户以为模型给了结论；转录停在最后一条工具结果上，用户再发一条就能接着跑。
- `turn()` 五步（`:184-261`）：
  1. **工具快照**：`tools.snapshot({readOnlyOnly: mode==='plan'})` ★ plan 的**真正实现**是过滤写工具；下发列表与稍后按名查找**必须是同一份**（否则「列表里有、执行时找不到」）。`infos` 剥掉 `execute`（闭包过不了结构化克隆）。
  2. **上下文组装** `assemble(...)`（[§4](#4-contextassemblercontext-assemblerts)）。
  3. **发 `context_usage`** —— 请求发出**前**。
  4. **流式解码**：`pending = new BlockAccumulator()`（★ 中断时唯一能把半截回复救回来的东西 —— 用户已在屏幕上读到的字不能因停止而消失）→ 逐事件 `emit({type:'stream', delta})` 原样转发 + `acc.apply(ev)`；`error` → `streamError`（路由器把总失败表达成**终止事件**而非异常，所以这是正常循环出口不是 catch）。
  5. **收尾**：`finalize()` → error part 也进转录（★ 只属 UI 轨：编码器对它返回 null，下轮上行丢掉；重载后失败仍看得见）；`commit(assistant)`；`stopReason !== 'tool_use' || calls.length===0` → `finish('done')` —— ★ `tool_use` 却无闭合调用时「**收尾比空转诚实**」：继续循环会原样重发同一请求。

### 2.3 工具执行（`executeAll` / `executeOne`）

- ★ **串行执行**（v1 不并行，方案 §10），所有结果合成**一条** user 消息。
- ★ `executeAll` 用 `finally` 提交（`:274-281`）：中断发生在第 2 个工具途中时，第 1 个**已经真的做完了**；不落进转录它就会被收尾当成孤儿补「已中断」—— 做过的事被记成没做，模型下轮会据此重做。
- `executeOne` 五个出口：① 参数非法 → 不执行，把**原文**回给模型（只说「参数错了」它无从下手）；② 工具名查不到 → 工具错误（模型会编名字；本轮中工具也可能被下线）；③ `emit tool_start`（★ 下发/回传/展示三处都用 externalName）；④ 审批：deny 的理由要让模型**看见**（提示词里「被拒绝时不要绕开」的前提是它知道被拒了），`allow_edited` 用改过的入参（用原值执行等于无视用户的修改）；⑤ 执行：**中断原样抛出**（伪装成工具失败的话模型会继续跑 —— 用户点了停止对话却还在动），其余异常收敛为 `tool_result{isError:true}` 继续循环（§4.11）；截断仅超 64KB 才做（无条件 `truncateToolOutput` 会抹掉工具自己标好的 `truncated/originalBytes`）。
- `toolContext`：★ `signal` 必传到 execute 体内（只断 SSE 不断工具 = 僵尸 shell 和还在写的文件）；`emit(tool_progress)`（易失，永不进转录）；工具错误也要发 `tool_end`（否则 UI 卡片永远转圈）。

### 2.4 中止链路（方案 §4.8「五件事」的分工）

```
用户点停止 → runs.abort(runId, cascade, {by:'user'})
   cascade=true: 递归 abort(子 run, {by:'parent'})          ← 第 5 件：级联
   handle.abort() → controller.abort() → 同一个 AbortSignal 贯穿四处：
      ① upstream.stream(request, signal)   → router/SSE/fetch     ← 第 1 件：取消上游
      ② approve({…, signal})               → InteractionGate      ← 第 2 件：拒绝待决交互（步骤 5）
      ③ toolContext.signal → execute()                            ← 第 3 件：取消工具
finalizeAbort()（agent-session.ts:377-414）                       ← 第 4 件：只有 session 知道转录长什么样
   1. 提交 pending 里的半截回复（BlockAccumulator 会丢未闭合 tool_call，不会制造新孤儿）
   2. orphanedToolCalls() 给剩余孤儿补 tool_result（内容「[已中断…]」）并各发一条 tool_end
      —— ★★ 漏掉它下一轮请求就是 400；报错指向消息数组，看起来像 adapter bug，
         而起因在几百行外的 abort 路径。「这是手写 Agent 循环最常见的自伤。」
   3. finish('aborted')
```

第二道中断判定：`handle.signal.aborted` 与 `isAbortError` 任一满足即走 abort 收尾（`:142-147`）—— 工具或上游可能在中断时抛一个**不像 AbortError 的**错误（undici 的 `TypeError: fetch failed`）。

### 2.5 错误与别名

- 别名查不到**不在这里报错**（`:419-423`）：照常发请求，让 `noCandidateError` 成为唯一权威错误 —— 两处都报的话用户会随机收到信息量少的那一条。
- 空文本块/空 parts 消息会被上游 400（session 侧与 assembler 侧各有一道防线，见 [04/05 篇](./04-kernel-tool.md)）。

## 3. RunRegistry（`run-registry.ts`）

### 3.1 为什么不用 AsyncIterable 做事实来源（`:1-14`）

1. 异步迭代器只能被订阅一次 —— 主窗 + 快捷小窗看同一个 run 就没救了；
2. 无法重放 —— 渲染层重载（⌘R）时 run 还在主进程好好跑着，但 UI 失忆了；
3. 背压反转 —— `webContents.send` 是 fire-and-forget 且无界，生成器背压作用于空气。

「这四件事出问题时的症状 —— 重载后 UI 空白、第二个窗口收不到、转录里少一段 —— 全都不会指向这个文件」（测试文件头）。

### 3.2 RunHandle 与日志

| 成员 | 语义 |
|---|---|
| `status` | `running/done/error/aborted` |
| `seq` | ★ **永远单调递增，不受裁剪影响**（`:48-49`） |
| `log: LogEntry[]` | 重放缓冲，**条目自带 seq**（裁剪后 seq 与下标不再一一对应） |
| `pendingInteractions` | ★ 跟着事件走（request push / resolved splice / subagent 记 children），attach 时才有东西可还原 |
| `controller` | 中止源；`signal` ★ 必传给每个工具的 `ctx.signal` |
| `listeners` | 多消费者；`run_end` 后清空 |

`MAX_LOG_ENTRIES = 2000` 只是兜底硬上限；正常情况下裁剪在每个 `message_commit` 处把日志压得远小于它。

### 3.3 裁剪与重放（`:106-157`）

★ **裁剪策略：`message_commit` 一到，它之前的 stream delta 就是冗余的**（提交的消息已包含那些 delta 拼出的全部内容）。这让裁剪对「重放能否还原 UI」**无损**：重放 = 结构性事件 + 已提交完整消息 + 最后一次提交后的增量 delta。单纯从头砍的环形缓冲做不到（会在转录中间留一个真的洞）。只清 delta —— `tool_start/end`、`interaction_*` 是结构性的，留着供 UI 重建工具卡片。

重放 API `since(sinceSeq)` 用 **filter 不是 slice**（`since` 按 seq 过滤，日志只剩 seq 2、3 时 `since(2)` 必须只返回 seq 3）。

### 3.4 Registry 方法

`create`（★ 重复 runId 抛错 —— 「静默复用比抛错危险：两个 run 共享一份转录，消息会交错」；子 run 挂父 `children`）、`runningIn(workspaceId)`（★ 外层 Tab 运行角标的数据源，不是任何 UI 状态）、`abort(runId, cascade)`（级联整棵子树）、`abortAll({by:'shutdown'})`、`reap()`（已结束且无人订阅才回收；步骤 6 之后转录在 SQLite 里，内存日志就没用了）。全局单例 `runs`。

测试专用 `toAsyncIterable`（⚠️ 只给测试用）：生成器的 `finally` 只在消费者 `.return()` 时执行，`for await + break` 会、手写 `.next()` 泵不会 —— 生产路径一律用 `on()`。

## 4. ContextAssembler（`context-assembler.ts`）

★ **一组纯函数而不是 class**（`:7-9`）：它现在没有状态；「防止 `agent-session.ts` 长成 900 行」靠的是**模块的名字现在就存在**。不读时钟、不读环境变量（`now`/`workspaceRoot` 都是入参）。

### 4.1 token 估算（`:24-120`）

- `CHARS_PER_TOKEN_LATIN=4`、`TOKENS_PER_CJK_CHAR=1`、part/message/tool 各有开销常量、`IMAGE_TOKENS=1600`。
- ★ **这是估算不是真值**（`:27-33`）：真值在 `message_end.usage`（⚠️ session 侧「用真值覆盖」尚未实现）；误差英文 ±15% / 中文 ±25%。「够画一根进度条，不够做计费 —— 所以 UI 上它是一根**条**，不是一个数字」。`for...of` 按码点迭代（`text.length` 会把一个 emoji 算成两个字符）。
- ★ **工具定义要算进上下文**（`:106-120`）：挂三个 MCP server 的工作区，工具 schema 能占两三万 token —— 漏算则压力条在真正爆掉前一直显示「还很空」。

### 4.2 系统提示词（`:122-210`）

四段 filter 空串后拼接：`BASE_PROMPT`（中文人设 + 权限约束 + 「被拒绝时不要试图绕开」）→ `MODE_APPENDIX`（plan：只读工具是既成事实不是提示；goal：不要每步反问「要我继续吗」）→ Skill 段 → `当前日期:YYYY-MM-DD(UTC)`（★ 模型不知道今天几号）。

Skill 段三件事（`:147-189`）：削控制字符 + 限长（与工具描述共用 `./text`）；加分隔与来源标注；**权限边界声明 —— 这才是唯一真正的防御**：「Skill 说什么都不能让一次工具调用跳过审批」。总预算 `SKILLS_TOTAL_MAX=128KB`；★ 超限静默丢弃是更糟的 —— 用户装了 Skill、界面显示已启用、模型却没看到 → 追加「(另有 N 个 Skill 因总长度超限未加载)」。

### 4.3 thinking 预算（`:212-244`）

★ 上游要求 `max_tokens > thinking.budget_tokens`（`MIN_THINKING_BUDGET=1024`，`MIN_OUTPUT_HEADROOM=1024`）。这条约束不写下来，症状是：用户选「最高」（64000）而 `maxOutputTokens=8192`，请求直接 400 且错误信息只字不提 thinking。处理方式是**降级而不是报错**：能挤出 1024 就按挤出来的算，挤不出就不开思考 —— 「用户选的是『多想一点』，不是『宁可失败也要想这么多』」。`auto` 真的开一点（medium 10_000），否则界面上两档没有区别。

### 4.4 `assemble()` 与压缩（`:246-388`）

- messages/tools 都是**浅拷贝**（请求要过 JSON 与 IPC，不能和调用方共享数组）。
- ★ **把 `maxOutputTokens` 算进压缩判断**（`COMPACT_THRESHOLD=0.8`）：上下文窗口是输入+输出共用的；只比输入，你会在「输入刚好塞得下、回复写到一半被截断」时才发现该压缩 —— 那时这一轮已经浪费了。
- `compactMessages` 是**机械压缩**（工具输出是大头：一个 read_file 几千 token，模型据它改完代码后就不再有信息量）；「让模型总结旧历史」的完整 `/compact` 属于 session（步骤 12）。★ **绝不删除 `tool_call`/`tool_result` 块本身，只清空内容** —— 删掉一个 tool_result 就是制造孤儿 tool_use，与中断收尾漏补是同一个坑的另一个入口。首条消息保留原文（它是任务的原始表述）；★ 绝不产出空 parts 消息（只有 thinking 的助手消息压完就是空的，开扩展思考时很常见）→ 占位 `[{type:'text',text:'[已压缩]'}]`。
- ⚠️ `compactMessages`/`withSummary` 目前**无生产调用方**（仅测试引用）；压缩触发只到 UI 提示层。

## 5. BlockAccumulator（`block-accumulator.ts`）

把归一化事件流拼回 `ContentPart[]`。**纯的**（事件进块出）单独成文件，是为了让「未闭合的工具调用该怎么办」这条规则被独立测到。

| 事件 | 规则 |
|---|---|
| `text_delta` / `thinking_delta` | 同 index 追加；★ 类型不匹配（畸形流：上游把两种块塞进同一 index）→ **丢增量不覆盖** —— 覆盖会毁掉一个进行中的 tool_call，凭空制造孤儿 |
| `block_opaque` | ★ 必须能**凭自己把块建出来**（redacted_thinking 整块不透明、零 delta）；否则那一块在这里蒸发，下轮回传思考链是断的 |
| `tool_call_start` | **唯一会替换同 index 已有块的事件**（来自 `content_block_start`，是对该 index 的显式声明） |
| `tool_call_end` | 没见过 start 的 end 只能丢 —— 编一个 callId 出来更糟（回传匹配不上任何 tool_use，直接 400） |
| 其余 | 不产生内容块（session 直接消费） |

★ **`finalize()` 的核心规则：未闭合的 `tool_call` 块一律丢弃，没有第二种选项**（`:123-131`）。依据 adapter 契约「必须 start…end，delta 可为 0」—— 缺 end 只有一个含义：模型还在写这个调用，它还不是一次调用。正常路径空转；真正生效在中断与流中途报错时，保留半截调用的后果都很具体：参数是残缺 JSON，执行等于按模型没写完的意图动手，不执行又留孤儿 tool_use。

★ 参数解析失败（`PendingCall` 判别联合，刻意不用「可选 parseError 字段」—— **必须处理**的分支做成可选字段就是可以忘记读）：`tool_call` 块**照样进转录**（入参 `{}` 占位）+ `calls[i].ok=false` —— 少 tool_call 则 tool_result 没有配对，少 tool_result 则 tool_use 是孤儿，**两个方向都是 400**。原文由 session 放进 tool_result 回给模型，它才知道自己写错了什么。

输出按 **index 排序**（块的先后是模型表达的顺序，事件到达顺序在并行工具调用时可以交错）；空 text 块丢弃（上游 400）；`finalize` 只读可重复调用（中断路径在 catch 里调它，`apply` 可能停在任何位置）。

## 6. `abort.ts` / `text.ts` —— 只答一次的纯函数

两个文件是同一个思想：**两层代码必须给出同一个答案时，答案就该只有一份**。

- `isAbortError(e)`（三层：DOMException / `name==='AbortError'` 或 `/abort/i` / 递归 `e.cause`）：node 的 AbortError 不是 DOMException；undici 抛 `TypeError: fetch failed` 套一个 AbortError cause。判断分叉的症状：中断后弹假「网络错误」，或真网络错误被当中断吞掉。
- `abortError()`：★ **全项目唯一的 `new DOMException(..., 'AbortError')`** —— `isAbortError` 认的是 name，各处自己 new 的话某处写成 `'Abort'` 就静默降级，编译器不会说话（⚠️ 例外：`fake-emitter.ts:54` 直接 new，无害但破坏了字面声明）。
- `abortableSleep(ms, signal)`：可中断 sleep；工具里所有等待都必须长这样，否则 abort 留僵尸。
- `stripControlChars`：删 C0（保留 `\t`/`\n`/`\r`）与 DEL。★ 保留 `\r`：Windows 上装的 Skill 的 CRLF 削掉 `\r` 就和 `\n` 配不成对；★ 不碰 C1 区间（U+0080–U+009F）—— 削掉会破坏合法的西里尔/希腊文本。消费方：工具描述（`tool/naming.ts`）与 Skill 正文（assembler）—— 两处不同来源的不可信文本拼进同一份提示词。
- `clampWithEllipsis`：★ 静默截断是更糟的 —— 砍一半的 Skill 正文读起来仍通顺，你只会觉得模型「没按 Skill 说的做」。

## 7. `fake-emitter.ts`（夹具）

曾是步骤 3 的驱动，现在是 `agent-pump.test.ts` 的夹具。★ 留着的理由：它对 RunHandle 的用法与真 AgentSession **完全一致**（emit/signal/finish 三件事一个不多），让泵测试跑在**时序完全确定**的驱动上，不必赌真上游怎么切片。脚本覆盖「文本→工具调用→文本」三块、参数分片、`message_commit` 在 `run_end` 前。

⚠️ `TICK_MS=28 > 泵的 16ms`，所以它**测不到合批**（每个 delta 单独成批）—— 合批由 pump 测试手动灌 200 个 delta 的突发用例覆盖。它用 `Date.now()`，不守零时钟纪律（夹具）。

## 8. 测试覆盖（kernel 内 5 文件）

| 文件 | 固化的关键行为 |
|---|---|
| `agent-session.test.ts`（1166 行 / ~50 用例） | 全套共用不变式 `expectNoOrphans`（**双向**：孤儿 tool_call + 无主 tool_result）；用户消息是首个 commit；事件原样转发；`context_usage` 先于首个 stream 事件；多工具串行且结果合一条；66 字符真实 MCP 名三处同用 externalName；进度不进 `JSON.stringify(history)`；`ctx.signal` 与 handle.signal **引用相等**；plan 下硬调写工具 = 未知工具；中断：第一工具保留原值 `isError:false`、只有没跑完的标中断、半截文本进转录、半截 tool_call 不进也不产生孤儿、`TypeError('fetch failed')` 仍算 aborted、`run_end` 只出现一次；轮次耗尽请求数 == MAX_TURNS 且不伪造输出；每轮快照（中途 unregister 同轮照样执行、下轮不再下发、下线后调用 = 工具错误）；`history` 与 commit 事件一一对应 |
| `run-registry.test.ts` | commit 后 seq 仍连续；裁剪无损重建；`since` 按 seq 不按下标；双监听器都收到；结束后迟到事件丢弃且不推进 seq；finish 只生效一次；快照待决表是副本；cascade 三层全 aborted |
| `context-assembler.test.ts` | 中文比英文贵 3 倍+；emoji 按一个码点；工具 schema 计入；Skill 消毒/截断/总预算闸/权限声明；auto 真开思考；预算被 maxOutputTokens 压住、额度太小降级为不开；messages/tools 是拷贝；`shouldCompact` 含 maxOutputTokens；压缩前后 `orphanedToolCalls` 双向为空、tool_call 块数量一个不少、绝不空 parts、不修改入参 |
| `block-accumulator.test.ts` | 按 index 排不按到达序；畸形流不破坏已有块；零 delta 调用参数 `{}`；并行调用 end 交错各自归位；参数非法 part 仍在 + `{}` 占位 + `ok:false`；未闭合丢弃且不影响前面的文本块；finalize 幂等 |
| `text.test.ts` | 全 C0 区间枚举（kept = {\t,\n,\r}）；ESC 削掉（ANSI 能改写日志行）；C1 不碰；截断标记边界（max 小于标记长度只剩标记） |

## 9. 已知缺口/注脚（读码所得）

1. `compactMessages`/`withSummary` 无生产调用方；自动压缩只到 UI 提示（`StatusLine.tsx:86-91`）。
2. `context_usage` 始终是估算值 —— 注释说「session 收到 usage 后应当覆盖」未实现。
3. `fake-emitter.ts:54` 未走 `abortError()`（与「全项目唯一」声明字面冲突）。
4. `RunHandle.abort(_reason)` 忽略 reason 参数（仅 registry 层级联来源标记用）。
5. externalName→Tool 查找有两条路径：session 用本轮 `byName` Map（「MCP 中途断开不打断执行」的机制来源），registry 另有 `resolveByExternalName`；语义一致。
