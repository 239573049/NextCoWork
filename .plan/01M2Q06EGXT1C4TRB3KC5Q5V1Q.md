# 会话目标（goal）机制 · 实施计划

> 目标：把 Claude Code 2.1.259 的 goal 机制完整移植进 NextCoWork —— **模型不再"答完就停"，
> 而是持续工作到一个独立判定器确认条件达成**。
>
> 参考实现来自本机 `@anthropic-ai/claude-code-darwin-arm64` 2.1.259 的原生包（bun bytecode，
> `strings` 后可读 JS chunk）。本文里凡是引号里的 prompt 都是**逐字原文**，不是转述。

---

## 0. 决策清单（已与用户确认，不再讨论）

| 维度 | 决定 |
|---|---|
| 范围 | **全量对齐 Claude Code**：闭环 + 模型自提目标 + 后台延迟判定 + check-in + 重载恢复 |
| 架构落点 | **扩展 hooks**：新增 `type: 'prompt'` 钩子，并把 `Stop` 钩子从 fire-and-forget 改成**可阻断 / 可续跑**。goal 只是运行期自动注册的一条内置 Stop prompt 钩子 |
| 判定模型 | 新增 `goalEvaluatorModel` 绑定（形状照抄 `permissionReviewerModel`），**只服务判定**，不接管标题/压缩摘要 |
| 判定器能力 | **只读对话**：无工具、禁思考、结构化输出 `{ok, reason, impossible}`；证据不足一律判未达成 |
| 续跑刹车 | **连续空转上限（默认 8）**；任何一次带工具的回合把它清零。不加总迭代上限、不加费用预算闸、不加"不可恢复错误自动清 goal" |
| 恢复策略 | **从转录恢复，不自动开跑**：重载后从最后一条 goal 标记反扫，未达成就重新挂上判定，但**不**自动继续；等用户下一句或手动继续 |
| 用户入口 | Composer 药丸 + 面板、状态行常驻、转录状态卡片、`/goal` 斜杠命令 —— **四个都要** |
| hooks 开放面 | **完全开放**：设置页可新建 prompt 型钩子；`Stop` 命令钩子的 `exit 2` 也获得阻断能力 |
| 模型自提目标 | 照搬 CC 三档：`auto` / `alwaysAsk` / `disabled` |
| 后台延迟判定 | 判据**只算后台子代理**（`Task(run_in_background: true)` 派生的 detached 子 run）。**Bash 没有 `run_in_background`，本次不补**，接口留成可扩展的「后台任务清单」 |
| check-in 节奏 | 照搬 CC：首次 30 分钟，指数退避到 60 / 120 分钟封顶；空闲注入上限 3 次 |

---

## 1. 现状事实（这些决定了方案的形状，不是背景介绍）

### 1.1 `Stop` 钩子今天**不能阻断，也不能续跑**

`src/main/runtime.ts:2282` 在 `running.finally(...)` 里发出 Stop，且是 `void ... .catch()`：

```ts
if (req.depth === 0 && req.parentSessionId === undefined) {
  void runHookEvent({ event: 'Stop', environment, sessionId, runId, extra: { status: handle.status } })
    .catch(() => undefined)
}
```

★ 这里**不 await 是刻意的**（文件内注释：落盘才是正事，不能让通知脚本拖慢转录落盘）。
所以 goal 需要的「回合末判定 → 未达成则继续」**不可能**挂在这个位置 ——
判定必须在**收割 run 之前**跑，续跑只能由内核那层循环接手。

### 1.2 内核的回合末收尾点在 `AgentSession`

`src/main/kernel/agent-session.ts:683`：

```ts
if (stopReason !== 'tool_use' || calls.length === 0) {
  this.closeUnexecutedCalls('[not executed: the model did not request tool execution]')
  if (stopReason === 'tool_use') { /* warn */ }
  this.handle.finish('done')
  return null          // ← 这一行就是「回合结束」的全部
}
```

`run() → loop() → turn()` 三层：`loop()` 是 `for(;;)`，每轮 `turn()` + `executeAll()`，
`turn()` 返回 `null` = run 结束。★ `loop()` 里已经有一个成熟的"注入后继续"先例 ——
`injectInterjections()`（`agent-session.ts:431`），注释里写明了为什么注入点必须在
「工具结果落进转录之后、下一次请求组装之前」。goal 的续跑消息走**同一个位置**，理由完全一样。

### 1.3 已有的可复用料（不要重造）

| 需要的东西 | 已有的东西 | 位置 |
|---|---|---|
| 注入一条"发给模型但不进聊天流"的消息 | `InterjectItem.internal` | `shared/agent/interject.ts:31`、`run-registry.ts:205`、`agent-session.ts:1208` |
| 旁路模型调用（system + 单条 user + 空工具 + 禁思考） | `createContextCheckpoint` | `agent-session.ts:826-876` |
| "某个模型 + 某个供应商"成对冻结的设置项 | `permissionReviewerModel` / `...ProviderId` | `shared/domain/settings.ts:210-212`、`runtime.ts:1804-1809`、`ipc/provider.ts:141-143/427-432` |
| 旁路模型返回决策 + 解析鲁棒性处理 | `reviewSensitiveOperation` | `runtime.ts` 1800 行附近（有 `allow/deny/unknown` 容错解析先例） |
| 内置工具 + 结构化输入 + 长描述 | `tool/builtin/todo.ts`、`interaction.ts` | `src/main/kernel/tool/builtin/` |
| 弹窗式人工确认 | `interactions.request(handle, draft, now)` + `InteractionPanel.tsx` | `kernel/interaction-gate.ts`、`views/chat/InteractionPanel.tsx` |
| "只存在于 UI 那一轨、编码时返回 null 的 part" | `{ type: 'error' }` | `shared/agent/message.ts:47`、`upstream/encode/anthropic.ts:90`（`return null`）；`openai-chat.ts` / `openai-responses.ts` 同理 |
| 本地动作型斜杠命令（不是模板） | `localActions` + `/compact` | `views/chat/Composer.tsx:477-481`、`647-657` |
| 钩子定义 / 加载 / 执行 / 试运行 | `hook.ts`、`hook/load.ts`、`hook/run.ts`、`main/hooks.ts`、`HooksPanel.tsx` | 见第 2 节 |
| 后台子代理 | `Task(run_in_background)` → `outcome.kind === 'background'` → 结果作为 internal 插话回传 | `tool/builtin/task.ts:152-188`、`subagent-queue.ts` |

### 1.4 两个"看起来能用、实际不能用"的坑

1. **`Stop` 的 payload 里没有 `stop_hook_active`**，CC 用它告诉判定器「你已经被叫过一次了」。
   NextCoWork 的 `HookPayload`（`hook/run.ts:50-70`）里没有这一项 —— 要加。
2. **运行期注册的钩子没有去处**：`hooksFor()`（`main/hooks.ts:65-92`）只从两份 settings 文件读。
   goal 需要一条"进程内注册、不落盘、run 结束即失效"的钩子，所以必须新增一个运行期钩子表（见 2.3）。

---

## 2. 数据形状与 hooks 扩展

### 2.1 `HookDefinition` 改成判别联合

`src/shared/domain/hook.ts`。今天 `command: string` 是必填、没有 `type`；
新增 prompt 型之后必须拆成两个分支，否则会出现"两种钩子共用一个必填字段"的错位
（和一个 `command: ''` 的 prompt 钩子，两个地方都要判断它是不是空串）。

```ts
export const HOOK_TYPES = ['command', 'prompt'] as const
export type HookType = (typeof HOOK_TYPES)[number]

interface HookBase {
  id: string
  event: HookEvent
  matcher?: string
  enabled: boolean
  timeoutMs: number
  description?: string
}

export interface CommandHook extends HookBase { type: 'command'; command: string }

/**
 * 模型判定型钩子。★ 它跑的不是本机命令，而是一次旁路模型调用 ——
 * 所以没有 command，却多了一个 prompt，并且在 Stop 上具备阻断能力。
 */
export interface PromptHook extends HookBase {
  type: 'prompt'
  prompt: string
  model?: string
  modelProviderId?: string
}

export type HookDefinition = CommandHook | PromptHook
```

配套改动：

- `HookFileEntry` 加可选 `type?: HookType`（缺省 `'command'` —— 老文件全部向后兼容）、
  可选 `prompt?: string`、可选 `model?: string`。
- `hook/load.ts` 的 `toDefinition` / `toFileEntry` 严格互逆地处理这个分支；
  `prompt` 分支缺 `prompt` 或 `command` 分支缺 `command` 时**丢弃该条并记诊断**
  （不要造一个永远跑不起来的条目出来）。
- 新常量：`HOOK_PROMPT_MAX = 4 * 1024`、`PROMPT_HOOK_DEFAULT_TIMEOUT_MS = 30_000`
  （CC 对 prompt 钩子的默认超时就是 30 秒，独立于命令钩子那条 60 秒）。
- **`Stop` 进入 `BLOCKING_HOOK_EVENTS`**。`BLOCKING_HOOK_EVENTS` 现有语义是
  「UI 据此决定要不要显示'阻断行为'那一段说明」+「`hasWeakBlockingMatcher` 的适用范围」，
  两处都要跟着改。

### 2.2 目标本身：`src/shared/domain/goal.ts`（新文件）

```ts
/** 目标是谁设的。遥测与 UI 文案都按它分叉。 */
export type GoalOrigin = 'user' | 'proposal_direct' | 'proposal_approved' | 'restored'

export interface ActiveGoal {
  /** 完成条件。★ 必须是"判定器只看对话也能核"的那一种，见 prompt 里的硬约束。 */
  condition: string
  origin: GoalOrigin
  /** 已评估轮数（达成/未达成各算一次；超时与出错不算）。 */
  iterations: number
  setAt: number
  tokensAtStart: number
  /** 上一次判未达成的理由。UI 那行「上次判定」用它。 */
  lastReason?: string
  /** 后台子代理在跑而推迟判定的起点。缺席 = 当前不处于推迟态。 */
  deferredSince?: number
  /** 本轮推迟已注入过几次 check-in。 */
  checkinCount: number
  lastDeferralPassAt?: number
  /** 空闲定时器注入次数，到 3 封顶。 */
  idleCheckinCount?: number
}

/** 判定器的一次结论。 */
export type GoalVerdict =
  | { kind: 'met'; reason: string }
  | { kind: 'not_met'; reason: string }
  | { kind: 'impossible'; reason: string }
  | { kind: 'skipped'; reason: 'timeout' | 'error' | 'no_model' | 'deferred' | 'transcript_empty' }
```

### 2.3 一个"只在 UI 那一轨"的 part：`goal_status`

goal 的达成/失败/清除**不能进模型上下文**（否则模型会开始为自己的历史成绩道歉，
和 `{type:'error'}` 的理由一模一样），但必须进转录、能被重载恢复反扫。

做法照抄 `{ type: 'error' }` 那条已验证的路：

```ts
// shared/agent/message.ts
| {
    type: 'goal_status'
    /** 达成 */
    met: boolean
    /** 判定器明确说"永远做不到"，与"这一轮没达成"分开 */
    failed?: boolean
    condition: string
    reason?: string
    iterations?: number
    durationMs?: number
    tokens?: number
  }
```

必须同步处理的六处（**每一处漏掉都会静默出错，不会报编译错误的地方是后三处**）：

| 文件 | 改动 |
|---|---|
| `upstream/encode/anthropic.ts` | `case 'goal_status': return null` |
| `upstream/encode/openai-chat.ts` | 同上 |
| `upstream/encode/openai-responses.ts` | 同上 |
| `kernel/context-assembler.ts:106` `estimatePart` | 返回 `0`（它不进上下文，不该占 token 预算） |
| `shared/agent/transcript.ts:569` | 转成 UI 用的节点（照 `error` 那一条） |
| `shared/domain/data.ts:492` | 导出/导入的 part 白名单 |
| `views/chat/Thread.tsx:835` | 渲染状态卡片 |

### 2.4 运行期钩子表：`src/main/hook-registry.ts`（新文件）

goal 注册的钩子**不落盘**：它是运行期状态，写进 `settings.local.json` 会让
「重载应用后旧 goal 还在文件里」和「用户手改文件把两条 goal 钩子叠在一起」两件事都发生。

```ts
/**
 * 运行期钩子 —— 只在进程内存里，`SessionEnd` 即失效。
 *
 * ★ 它和 `settings.local.json` 里那些是**并列**的两个来源，不是覆盖关系：
 *   `hooksFor()` 把两边拼起来（文件在前、运行期在后），
 *   `MAX_HOOKS_PER_EVENT` 的上限对合并后的总数生效。
 */
registerRuntimeHook(sessionId: string, hook: HookDefinition): void
removeRuntimeHook(sessionId: string, hookId: string): void
runtimeHooksFor(sessionId: string): readonly HookDefinition[]
clearRuntimeHooks(sessionId: string): void   // SessionEnd / run 收尾时调
```

接入点：`main/hooks.ts` 的 `hooksFor()` 在拼完两份文件之后追加
`runtimeHooksFor(sessionId)`；`runHookEvent` 的签名要能拿到 `sessionId`
（已经有了）和一条新的 `runtimeHooks` 参数（测试注入用）。

`runtime.ts` 的 `resetRuntimeForTest()` 里必须 `clearRuntimeHooks()` ——
和 `subagentQueue.reset()` 同一个理由（跨用例泄漏会让下一个用例被上一个钩子叫醒）。

---

## 3. 运行时：判定、续跑、刹车

### 3.1 新的一条依赖缝：`SessionDeps.onTurnEnd`

形状参照 `onToolExecuted`（`agent-session.ts:117-123`）—— 内核只定义缝，
「判定器是谁、钩子从哪来」全部留在 `main/`。内核仍然零 electron、可单测。

```ts
/**
 * 回合末的一次询问。★ **只有主 run 会调**：子 run 没有"停止"这回事。
 *
 * 返回 `continue` 时内核把 `inject` 提交成一条 internal 用户消息并继续循环；
 * 返回 `finish` 或 undefined 时按原路径收尾。
 */
onTurnEnd?: (input: TurnEndInput) => Promise<TurnEndResult | undefined>

export interface TurnEndInput {
  sessionId: string
  workspaceId: string
  runId: string
  /** 到这一刻为止的完整转录 —— 判定器的输入就是它 */
  messages: readonly AgentMessage[]
  isSubagent: boolean
  /** 本 run 至今调用过的工具总数。刹车判据用它区分「空转」和「干活」 */
  toolCallsThisRun: number
  signal: AbortSignal
}

export interface TurnEndResult {
  kind: 'continue' | 'finish'
  /**
   * 继续时注入的内容。★ 必须是 `internal` 的那一类 —— 它是协作消息，
   * 不是用户说的话，不该出现在聊天气泡里（同 `InterjectItem.internal` 的理由）。
   */
  inject?: ContentPart[]
  /** 一条只进 UI 那一轨的状态标记（达成 / 未达成 / 判为不可能）。 */
  goalStatus?: Extract<ContentPart, { type: 'goal_status' }>
  /** 判定的文字结论，给日志与遥测用。 */
  note?: string
}
```

### 3.2 `turn()` 的收尾改成"先问，再决定"

`agent-session.ts:683` 那一段（含 `closeUnexecutedCalls` 的调用顺位）改成：

```ts
if (stopReason !== 'tool_use' || calls.length === 0) {
  this.closeUnexecutedCalls('[not executed: the model did not request tool execution]')
  if (stopReason === 'tool_use') { /* warn，原样保留 */ }

  /*
    ★ 回合末的判定点。位置被两头夹死：
    - 必须在 `closeUnexecutedCalls` **之后** —— 判定器读的转录必须已经配对完整，
      否则它会看到一串没有 tool_result 的 tool_call，那是我们自己的半成品状态。
    - 必须在 `handle.finish('done')` **之前** —— 一旦收尾，run 就从注册表摘掉了，
      再想继续就是"同一轮里的第二次 run"，用户看到的是两次回答。

    ★ 判定器抛异常**必须在这里兜住**。结构上它每一轮 end_turn 都会被调用，
      一次成功的抛异常 = `for(;;)` 无限重试同一个请求。降级成「这一轮不判定」。
  */
  let turnEnd: TurnEndResult | undefined
  try {
    turnEnd = await this.deps.onTurnEnd?.({
      sessionId: this.req.sessionId,
      workspaceId: this.req.workspaceId,
      runId: this.req.runId,
      messages: this.messages,
      isSubagent: this.req.depth > 0,
      toolCallsThisRun: this.toolCallsThisRun,
      signal: this.handle.signal
    })
  } catch (err) {
    this.deps.host.logger.warn('[session] 回合末判定失败，本轮按正常收尾处理', err)
  }

  if (turnEnd !== undefined) {
    // ★ goalStatus 走**追加到上一条消息**，不单独 commit 一条新消息 —— 理由见下面那段。
    if (turnEnd.goalStatus !== undefined) this.attachGoalStatus(turnEnd.goalStatus)
    if (turnEnd.kind === 'continue') {
      this.stoppedTurnStreak += 1
      const at = this.deps.host.clock.now()
      /*
        ★ `internal` 要**展开设置**，不能当构造器的参数传：`userMessage(id, parts, now)`
          只有三个参数（`shared/agent/message.ts:80`）。照 `injectInterjections`
          里那条既有写法（`agent-session.ts:1208`）来。
      */
      this.commit({ ...userMessage(ulid(at), turnEnd.inject ?? [], at), internal: true })
      continue
    }
  }
  this.handle.finish('done')
  return null
}
```

**★ `goal_status` 不能单独 commit 成一条助手消息。** 它编码后是 `null`，
所以那条消息的内容块数是 0 —— 而「空 content 的消息是 400」
（`encode/anthropic.ts` 文件头第 1 条规则）。今天 `commitAssistant` 里那条
`if (parts.length === 0) return` 拦的是"数组为空"，拦不住"数组里有元素但都编码成 null"。

所以新增一个助手方法，把标记**追加到最后一条消息**上：

```ts
/**
 * 把只属于 UI 那一轨的标记挂在最后一条消息上。
 *
 * ★ 追加而不是新 commit：`goal_status` 编码后是 null，单独成一条就是一条
 *   零内容块的助手消息，而上游对空 content 是 400。
 *   挂在别人身上既保住了转录（重载恢复要反扫它），又不会新增一条上行消息。
 *
 * ★ **两个数组按 id 对齐**，不能靠引用 —— 构造函数里
 *   `this.contextMessages = this.messages.map((m) => ({ ...m, … }))`
 *   （`agent-session.ts:324`）产出的是**另一批对象**，`indexOf` 永远找不到。
 *   正确做法是只改转录那一份：`goal_status` 本来就该**只**存在于转录里，
 *   不进 `contextMessages` 才是它该有的样子（编码器那条 `return null`
 *   是为了防"它被别人带进去了"，不是为了让它进去）。
 */
private attachGoalStatus(part: Extract<ContentPart, { type: 'goal_status' }>): void {
  const index = this.messages.length - 1
  const last = this.messages[index]
  // ★ 只在助手消息上挂：用户那一轨不能出现"目标状态"，两轨必须分开。
  if (last === undefined || last.role !== 'assistant') return
  const next: AgentMessage = { ...last, parts: [...last.parts, part] }
  this.messages[index] = next
  this.deps.onMessageCommit?.(next)          // 先落盘
  this.handle.emit({ type: 'message_commit', message: next })
}
```

★ **上一条消息在 `finish` 那条路上必然是助手消息**（模型刚说完话，什么都没请求）。
在 `continue` 那条路上也可能不是（空 input 的续跑场景）—— 那时就退化成
"只发 `goal:changed` 广播、不进转录"。那种场景下转录里本来也没有助手消息可挂，
重载后那个目标恢复不出来是**正确的**：那一轮什么都没发生。


两个新增的本 run 内计数（run 结束即归零）：

- `toolCallsThisRun`：在 `executeAll()` 里累加。**它是刹车唯一判据的来源** ——
  判定器那层不该自己去看"这轮有没有调工具"。
- `stoppedTurnStreak`：拿到 `continue` 时 `+1`，`executeAll()` 里跑到任何一次工具调用时 `= 0`。
  这就是"连续空转"的定义。

★ 为什么 streak 复位放在内核的 `executeAll` 而不是判定器里：判定与续跑是**两个层**的事。
`main/` 那层只知道"这一轮模型有没有要求工具"，它连工具执行都看不到。
复位放在内核，`main/` 那层就只需要读一个数。

★ `onTurnEnd` 在子 run 的 deps 里**压根不装配**（装配点在 P1，见第 7 节），
所以 `depth > 0` 时这个 `await` 是 `undefined?.()` —— 不产生任何额外开销，
也没有第二条"要不要判定"的判断路径。

### 3.3 刹车：连续空转上限

在 `main/` 那层（`main/goal/runtime.ts`，见 4.4）：

```
stoppedTurnStreak >= GOAL_IDLE_STREAK_CAP（默认 8）
  → 强制收尾 + 一条可见警告（走 handle.emit 的 notification 通道，
     不复用 hooks 的 stop-hook-error —— 那是另一个来源，混在一起会让用户
     去 hooks 设置里找一个不存在的钩子）
```

★ 语义边界要写清：**它拦的是"模型什么都不做还想停"，不是"长任务跑了很久"**。
任何一次带工具的回合都把它清零，所以一个老实干活的目标可以跑几百轮而从不触发。
这正是本次**不加总迭代上限**的理由：连续空转上限已经覆盖了唯一的真死循环形态，
而一个总轮数上限只会误伤真正在收敛的长任务。

### 3.4 判定器出错 / 超时 / 没有可用模型

一律**降级为「这一轮不判定」**：不继续、不达成、不清除。
`TurnEndResult.note` 记原因，`goalStatus` **不发**（避免 UI 上刷一屏"未达成：超时"），
但把失败写进 `hooks:diagnostics` 那条环形缓冲（`main/hooks.ts:37 recordFailure`），
面板顶部挂红条 —— 这是用户唯一能发现"我的判定器其实一直在报错"的地方。

对应 CC 的 `tengu_hook_prompt_timeout` 与 `Hook evaluator API error` 两条诊断。

### 3.5 四种结局各自的收尾动作

| 结局 | 动作 |
|---|---|
| `met` | 摘运行期钩子 → 清 `activeGoal` → 发 `goal_status{met:true}` → **本 run 立即收尾** |
| `impossible` | 同上，但 `goal_status{met:false, failed:true}`，通知里明说「条件被判定为无法达成」 |
| `not_met` | `iterations++`、`lastReason = reason` → 发 `goal_status{met:false}` → 发 `goal:changed` → 继续 |
| `skipped` | 什么都不发（`deferred` 例外：它要注入 check-in 正文，见第 4 节） |

★ `met` / `impossible` 之后**必须在同一次 `onTurnEnd` 里返回 `{kind:'finish'}`**。
不这么写的话，"下一次 `onTurnEnd` 看到 `activeGoal === undefined` 于是返回 undefined"
也能收尾 —— 但那是**靠巧合**对，而不是靠不变量。将来任何一次改动都可能打破它。

---

## 4. 判定器与后台延迟

### 4.1 目录

```
src/main/goal/
  prompt.ts       判定器的 system / user / 续跑 / kickoff / check-in 文案（纯常量，可单测）
  evaluate.ts     旁路模型调用 + schema 校验 + 转录预算裁剪（纯函数 + 注入的 stream 端口）
  runtime.ts      接线：何时判定、何时延迟、何时清、定时器、遥测
  restore.ts      从转录反扫恢复（纯函数）
```

★ 为什么拆四份而不是塞进 `main/runtime.ts`：`runtime.ts` 已经 2300 行。
而且 `prompt.ts` / `restore.ts` 是纯的 —— 它们能像
`kernel/hook/load.ts` 那样"每一行都单测"，而判定逻辑的正确性几乎全在这两处。

### 4.2 判定调用（`evaluate.ts`）

完全照 `createContextCheckpoint`（`agent-session.ts:826-876`）那条旁路调用的形状，
差别只在输出契约：

| 维度 | 值 |
|---|---|
| 模型 | `settings.goalEvaluatorModel`，**空串 = 回落到本次 run 的模型**（`req.model`） |
| 供应商 | `settings.goalEvaluatorModelProviderId`，与模型**同一刻冻结**（同 `runtime.ts:1804` 那段注释的理由） |
| system | 见 4.3（英文原文，与 CC 逐字一致） |
| messages | `[userMessage(condition + 转录裁剪前缀 + 转录文本)]`，**一条** |
| tools | `[]` |
| thinking | `'off'`（CC：`{type:'disabled', mechanical:true}`） |
| maxOutputTokens | `1024` |
| 输出解析 | 见下 |
| 超时 | `PROMPT_HOOK_DEFAULT_TIMEOUT_MS = 30_000`，超时 = `skipped{timeout}` |

**输出契约**：CC 用的是 `outputFormat: json_schema` 严格结构化输出，但 NextCoWork 的
`ProviderStreamEvent` 里没有这一项。两条路：

- **首选**：把 JSON 契约写进 system prompt，然后按 `reviewSensitiveOperation` 那条
  **容错解析**的路子处理（剥 ```json 围栏、首个 `{` 到最后一个 `}`、`JSON.parse` 失败降级）。
  这样跨供应商一致 —— 结构化输出在 OpenAI 兼容 / Bedrock / Vertex 各家的支持程度不一样，
  而 `<appData>` 里配的供应商是用户自己挑的。
- 不做：给 `CanonicalRequest` 加 `responseFormat`。那是另一件事（会影响所有请求的编码路径），
  而且它不是 goal 正确性的必要条件。

解析结果一律过一遍 zod（`shared/domain/goal.ts` 里导出的 `goalVerdictSchema`）：

```
{ ok: boolean, reason?: string, impossible?: boolean }
```

- 解析失败 / schema 不符 / API 错误 → `skipped{error}`，**不**算未达成。
- `ok === true` → `met{reason}`
- `ok === false && impossible === true` → `impossible{reason}`
- 其余 → `not_met{reason}`

**转录预算裁剪**（照 CC 的 `yas`）：预算 = 模型上下文 × `0.5`（大窗口模型按 1e6 算），
按 turn 边界从后往前裁，裁掉的部分**替换成一条显式前缀**（逐字照 CC）：

> `[Earlier conversation truncated to fit the hook evaluator's context window — N earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`

★ 这条前缀不是客套话，它是**判定的正确性的一部分**：不写的话，被裁掉的那段历史
会让判定器把"我看不到"读成"没发生过"，于是稳定地误判未达成。
裁剪后仍然 `context_length` → 按 `0.25` 预算重试一次，再失败就 `skipped{error}`。

### 4.3 prompt 全文（逐字，来自 CC 2.1.259）

**判定器 system（Stop 专用）** —— 原样保留英文，理由见本节末：

```
You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.
Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}
Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.
Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".
```

**判定器 user（Stop 专用）**：

```
Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.
Condition: <condition>
```

**续跑注入（判未达成时发给主模型的那条 internal 消息）** —— 格式与 CC 一致：

```
Stop hook feedback:
[<condition>]: <reason>
```

**kickoff（目标生效时发给主模型的那条 internal 消息）**：

```
A session-scoped Stop hook is now active with condition: "<condition>". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run /goal clear after success; that's only for clearing a goal early.
```

**后台推迟的 check-in**（照 CC 两种分支）：

```
Goal check-in: «<condition>» is still active, and evaluation has been deferred for <N> min because background work is still running:
- <taskId> · <type> · <description>

Check on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting; if they are stuck or no longer needed, fix or stop them and continue toward the goal.
```

```
Goal check-in: «<condition>» is still active. Its evaluation was deferred for <N> min while background work ran, and that work is no longer running (it finished or was stopped without reporting back). Continue toward the goal.
```

空闲触发的最后一轮追加（CC 原文，用于"唤醒上限到了"）—— 上面两段的 `summary`/`body`
分别追加这两个后缀：

```
 · idle check-ins paused until your next message
```
```
 Claude Code won't wake this session for another check-in until the user sends a message, so say clearly where things stand.
```

（`Claude Code` 换成产品的自称；`«»` 是 CC 用来包住条件原文的定界符，
保留它是为了让判定器在 check-in 里也能一眼认出"这是那段条件"。）

★ **这些注入进模型上下文的话保持英文**，理由和 CC 一致、也和本项目既有做法一致：
`agent-session.ts:832` 的压缩摘要指令、`BASE_PROMPT` 都是英文。
换语言会改变判定器的行为（"insufficient evidence" 这句话在英文 prompt 里的
权重是被调过的），而用户可见的文案（药丸、状态行、卡片、通知）**全部走 i18n**，见第 6 节。

★ 唯一的例外是那条 `Stop hook feedback:` 前缀 —— 它同时是**格式**也是**锚点**
（`StoppedTurn`/诊断要按它认自己注入的消息），保持英文，并作为常量放在
`main/goal/prompt.ts` 里导出，不要在别处硬编码字面量。

### 4.4 后台延迟判定（`runtime.ts`）

**判据**：本 run 名下还有 `run_in_background` 派生的、未完成的子 run。

```
BACKGROUND_WORK_QUERY = () => 当前 session 的 detached 子 run 列表
```

`main/` 那层已经有这份数据（`subagent-queue.ts` 的占用表 + run registry 的父子关系），
新增一个只读查询函数即可，**不要**新造一份平行的登记表。

逻辑：

```
1. 有后台子代理在跑？
   是 → 摘掉运行期 goal 钩子（本轮不判）→ 记 deferredSince（首次）
        → 按 4.5 决定要不要注入 check-in → 返回 {kind:'finish'}
   否 且 deferredSince 存在 → 清掉 deferredSince/checkinCount（回到正常判定）
2. 正常判定（4.2）
```

★ 为什么"摘钩子"和"返回 finish"是同一件事的两面：本轮**不**判定，
所以既不能继续（没有依据），也不能把 `not_met` 记进 `iterations`
（那会让 UI 的轮数变成一个假数）。摘钩子是为了让**下一次** `onTurnEnd`
看到一个干净的、没有 pending 判定的状态。

### 4.5 check-in 定时器

照 CC 的 `xee` / `mnt` 那一套，参数照搬：

| 参数 | 值 | 说明 |
|---|---|---|
| 基础间隔 | 30 分钟 | `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` 可覆盖 |
| 退避 | `interval × 2^min(checkinCount, 2)` | 30 → 60 → 120 封顶 |
| 最小重装 | 60 秒 | 防止 0/负延迟变成忙等 |
| 空闲注入上限 | 3 次 | 到顶后只重装定时器，不再注入 |
| 定时器 | `setTimeout(...).unref()` | ★ 必须 unref：**不能让一个挂着的 check-in 拖住应用退出**（同 `runtime.ts:2276` 对 Stop 钩子那段注释的理由） |

★ 定时器必须在 `abortAll()` / 会话删除 / goal 清除时**显式 clear**。
一个 `unref()` 过的定时器不会阻止退出，但它会**在应用还没退出时**叫醒一个已经没了的 session。
CC 那边对应的是 `Dht()`（清掉 `pendingGoalIdleCheckin`）。

★ 定时器注入的那条消息走**和续跑同一条路**（internal 用户消息）。
不要为它新开一条"从外部叫醒 run"的通道 —— 那个通道要处理
"run 已经结束、得新起一个 run"的情形，而检测到"后台工作已经不在跑了"的
正常路径本来就是**子代理结果回传触发的新一轮**（`Task` 的 background 分支）。
定时器只是**兜底**：防的是"子代理卡住、永远不回传"。

---

## 5. 四个入口

### 5.1 目标状态机（`src/main/goal/state.ts`，新文件）

一份进程内状态 + 一条事件。**不落盘**（落盘的是转录里的 `goal_status` part，见 5.5）。

```ts
getActiveGoal(sessionId: string): ActiveGoal | undefined
setActiveGoal(sessionId: string, goal: ActiveGoal, hookId: string): void   // 注册运行期钩子
clearActiveGoal(sessionId: string, reason: GoalClearReason): void          // 摘钩子 + 清状态 + 遥测
onGoalChanged(listener: (sessionId: string, goal?: ActiveGoal) => void): () => void
```

`GoalClearReason = 'user_clear' | 'superseded' | 'met' | 'impossible' | 'session_ended' | 'run_failed'`

★ `setActiveGoal` 里必须**先清旧的**再装新的（摘掉旧的运行期钩子）。
漏掉的话，一个 session 里会同时挂着两条 prompt 钩子，判定跑两遍、
账单翻倍，而两遍的结论还可能不一样（各自独立调用模型）。

### 5.2 `/goal` 斜杠命令

走 `Composer.tsx` 已有的 `localActions` 那条路（`/compact` 的先例，行 477-481 / 647-657）。
**不是** `shared/domain/command.ts` 的模板命令 —— 那里展开的是提示词，展开不出状态变更。

要改的两处：

1. `Composer.tsx:477` 的 `localActions` 元素形状要能拿到参数：`run: (args: string) => void | Promise<void>`，
   `/compact` 那份 `run: () => onCompactContext()` 不受影响（多一个用不到的参数）。
2. `localActions` 要支持**多个别名**（CC 的清除词是一组）：

```ts
const GOAL_CLEAR_WORDS = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'] as const
const GOAL_CONDITION_MAX = 4000
```

行为（照 CC 的 `Ot`，交互与非交互共用一份判定）：

| 输入 | 结果 |
|---|---|
| `/goal`（空参数） | 打开面板：显示当前条件、已评估轮数（`0` 时显示"尚未评估"）、上次判定理由；无目标时显示 `No goal set` + 用法提示 |
| `/goal clear`（及六个同义词） | 清除；无目标时提示 `No goal set` |
| `/goal <条件>`，条件 > 4000 字符 | 拒绝并给出实际长度（**不截断** —— 截断后的条件会静默变成一个用户没同意的目标） |
| `/goal <条件>` | `setActiveGoal(origin:'user')` → 注入 kickoff → 条目本身**不进对话流**（它没有正文） |
| `/goal <条件>` 且当前已有目标 | 覆盖旧的，遥测记 `superseded` |

面板与药丸见第 6 节。命令的描述文案走 i18n（`composer.command.goal`）。

### 5.3 `ProposeGoal` 内置工具

新文件 `src/main/kernel/tool/builtin/goal.ts`，形状照 `todo.ts` / `interaction.ts`。

```ts
name: 'ProposeGoal'
input: {
  /** ★ 描述里必须写死"判定器只看对话"，这是把不可验证的目标挡在源头的唯一手段 */
  condition: string   // 1..500
  ask_user?: boolean  // 默认 true
}
output: { condition: string; askUser: boolean }
readOnly: true
concurrencySafe: false
```

**工具描述（给模型看的 prompt）逐字照搬 CC，并把 `500` 换成常量引用**：

```
Propose a completion condition for this session's work — a goal that keeps you working until a separate evaluator confirms it is met. Non-blocking: the proposal renders alongside your work, so keep working while it is handled.
ask_user true (the default) asks the user first, with a one-keypress approval dialog. If they decline you will not be notified — do not ask about the decision and do not re-propose the same or a reworded condition. Set ask_user false — which sets the goal directly, with no dialog — ONLY when the user's own words in this conversation stated this outcome as what they want; if you inferred it from their intent or the task's shape — or are in doubt — ask. Either path confirms a set goal with a kickoff message; until that message arrives, no new goal is active.
Propose only when the user has asked for an outcome with a verifiable end state ("make the tests pass", "migrate every call site") and the work spans multiple turns. Not for one-off tasks, and never to widen scope: the condition must follow from their request.
The evaluator verifies the condition from the conversation alone — it cannot run commands or read files — so state one measurable end state with its check (e.g. "bun test exits 0"), in at most 500 characters. One goal is active at a time; a newly approved or directly set proposal replaces the current one.
```

`isEnabled()` 的**五道门**（每一道都要有，缺一道就是一次白跑的工具调用 + 一条错误）：

1. 子 run 里不可用（`depth > 0` —— 子代理没人可问，同 `interaction.ts` 的处理）
2. 非交互会话不可用
3. `settings.modelProposedGoals === 'disabled'` → 不可用
4. 当前 session 已有目标且正在等审批 → 不可用（照 CC：`A goal proposal is already awaiting the user's decision.`）
5. **plan 模式下不可用** —— 让模型先把计划走完再提目标

`call()` 的两条路径：

- `ask_user === false` 且设置是 `auto`：直接设立（`origin: 'proposal_direct'`），
  同时在转录里留一条**可见**的提示行告诉用户"目标是模型直接设立的，可用 `/goal clear` 清除"。
  ★ 这条可见提示不能省 —— 它是这个默认值能成立的全部理由。
- 其余：走 `interactions.request(handle, { kind: 'goal_proposal', condition }, now)`，
  用户批准后设立（`origin: 'proposal_approved'`）。
  **审批结果不通知模型**（照 CC）—— 工具结果文本里已经说了"别等、别问、别提第二次"。

工具结果文本（照 CC 两种分支）与审批弹窗的形状见第 6 节。

### 5.4 设置

`src/shared/domain/settings.ts` 新增两个字段，形状照 `permissionReviewerModel` 那一对：

```ts
/** 目标判定模型。空串 = 回落到本次 run 的模型。 */
goalEvaluatorModel: string
/** 与 `goalEvaluatorModel` 成对，见 `defaultModelProviderId` 上那段。 */
goalEvaluatorModelProviderId?: string

/** 模型自提目标。缺省 'auto'。★ 影响的是"要不要弹审批"，所以只从可信来源读。 */
modelProposedGoals: 'auto' | 'alwaysAsk' | 'disabled'
```

必须同步的四处（漏一处就是"设置改了不生效"或"配置同步后两边不一致"）：

| 文件 | 改动 |
|---|---|
| `shared/domain/data.ts` | 校验：`goalEvaluatorModel` 必须是 string，`modelProposedGoals` 白名单；导出/导入带上 |
| `shared/domain/config-sync-registry.ts:17-18` | 归到 `'providers'` 分组（跟 `permissionReviewerModel` 一样） |
| `main/ipc/provider.ts:141-143 / 427-432` | 供应商改名 / 删除时的**成对修复**（`repairModelSelection`） |
| 设置页 | 见第 6 节 |

★ `modelProposedGoals` 与 `permissionReviewerModel` 是同一类东西（**影响同意**），
所以只从 user / policy 读，**忽略仓库内 project/local settings**。
这条规则在 CC 的 schema 里写得很明白（`modelProposedGoals` 那段 describe），
本项目 `settings.ts` 里 `defaultPermissionMode` 也是同样处理，照抄即可。

### 5.5 重载恢复（`main/goal/restore.ts`）

纯函数。输入转录，输出「要不要重新挂上目标」。

```
从后往前扫 parts，找 type === 'goal_status'：
  - 找到 met === true 或 failed === true 的 → 这个目标已经结束，返回 null
  - 找到 met === false 且没有 failed 的（含"清除"那条标记）→ 目标当时是活的
      → 返回它的 condition，以 origin: 'restored'、iterations: 0、setAt: now 重建
  - 一条都没有 → 返回 null（这条对话从来没设过目标）
```

★ `iterations` 重置为 0 而不是延续历史值：恢复之后的轮数应该是"这一次会话里的"，
继续累加会让 UI 上出现一个用户没法解释的数字（他明明只看到两三轮）。

★ **恢复只重建状态，不重开一轮 run。** 这是用户的明确选择，也和
`shared/domain/session.ts:51` 那条「永不恢复运行中状态」的原则不冲突 ——
我恢复的是**目标**（一个待满足的条件），不是一个运行中的 run。
用户下次发消息时，判定自然接上。

---

## 6. UI、i18n、IPC

### 6.1 IPC 与事件

`src/shared/ipc/contract.ts` 新增三个频道 + 一条广播：

```ts
'goal:get':    { req: { sessionId: string }; res: ActiveGoal | undefined }
'goal:set':    { req: { sessionId: string; condition: string }; res: { ok: true } | { ok: false; reason: string } }
'goal:clear':  { req: { sessionId: string }; res: void }
```

```ts
// Events（与 'hooks:changed' 同一组）
'goal:changed': { sessionId: string; goal?: ActiveGoal }
```

★ **不走 `agent:event`**。`agent:event` 是 run 生命周期内的流（有 seq、有 attach 补齐语义），
而 goal 的状态比 run 长：设目标时可能根本没有 run 在跑，run 结束后目标还活着。
塞进 `agent:event` 会让 `agent:attach` 的 seq 补齐逻辑多出一种"这条事件不属于任何 run"的分支。

`src/shared/agent/interaction.ts` 新增一种交互：

```ts
| { kind: 'goal_proposal'; id: string; sessionId: string; condition: string }
// InteractionResponse
| { id: string; kind: 'goal_proposal'; approved: boolean }
// INTERACTION_SOUND 加一项 —— 新增 kind 时这个 Record 会直接报编译错误，正是想要的
```

### 6.2 四个入口的 UI

| 位置 | 文件 | 内容 |
|---|---|---|
| Composer 药丸 | `views/chat/Composer.tsx` | 「目标」药丸：未设 → 点开面板写条件；已设 → 显示截断后的条件，悬停出完整条件与轮数/耗时；药丸上带一个清除入口 |
| 目标面板 | `views/chat/GoalPanel.tsx`（新） | 形状照 `ContextCheckpointPanel.tsx`：条件全文（可复制）、已评估轮数、上次判定理由、耗时与累计 token、「提前结束」按钮 |
| 状态行 | `views/chat/StatusLine.tsx` | 常驻一条：`目标 · <条件截断>` +（有 `lastReason` 时）上次判定理由。★ 复用 `StatusLine.tsx:256` 那个 `case 'error'` 的排版分支，不要新造一套行内布局 |
| 转录卡片 | `views/chat/Thread.tsx:835` 附近 | `case 'goal_status':` 四种形态 —— 已设置 / 已达成 / 判为不可能 / 已清除。★ 与 `case 'error'` 并排，共用同一套图标与缩进 |
| hooks 设置页 | `views/extensions/hooks/HooksPanel.tsx` | 新增钩子时先选类型（命令 / 模型判定）。prompt 型：多行 prompt 输入、可选模型与供应商（复用设置页那个模型选择控件）、超时默认 30 秒。★ 试运行对 prompt 型只做**预览替换结果**（把示例 payload 替进 `$ARGUMENTS` 给用户看），不真调模型 —— 真调需要一次 run 的上下文，那会把"试运行"变成一个语义模糊的东西 |

★ `Stop` 进入 `BLOCKING_HOOK_EVENTS` 之后，hooks 面板那段「阻断行为」说明
会自动覆盖到 Stop（因为它是按 `BLOCKING_HOOK_EVENTS` 渲染的），
文案要跟着补一句：**Stop 的阻断不会终止 run，它会继续跑** ——
这一点和 PreToolUse / UserPromptSubmit 的"拦住"是相反的效果，
不说清会让用户在设置里配出一个他没想到的死循环。

### 6.3 i18n（AGENTS.md 硬要求）

所有用户可见文案走 `src/renderer/src/i18n/index.tsx` 的 `ZH` / `EN` 两张表，
`useI18n().t(...)` 取。新增键（两边都要加，缺一边 `index.test.ts:9` 那条
「has a complete English catalog for every Chinese key」会直接红）：

```
goal.pill.label / goal.pill.none / goal.pill.clear
goal.panel.title / goal.panel.condition / goal.panel.iterations / goal.panel.lastCheck
goal.panel.elapsed / goal.panel.tokens / goal.panel.stopEarly / goal.panel.empty
goal.card.set / goal.card.met / goal.card.impossible / goal.card.cleared
goal.card.reason / goal.card.iterations
goal.notice.directSet            // 模型直接设立目标时那条可见提示
goal.warn.idleStreak             // 连续空转被强停
goal.warn.evaluatorFailed
goal.proposal.title / goal.proposal.body / goal.proposal.approve / goal.proposal.decline
goal.error.tooLong / goal.error.empty / goal.error.planMode / goal.error.disabled / goal.error.busy
composer.command.goal / composer.command.goalClear / composer.goal.hint
settings.goal.evaluatorModel / settings.goal.evaluatorModelHint
settings.goal.modelProposedGoals / settings.goal.modelProposedGoals.auto / .alwaysAsk / .disabled
hooks.type.command / hooks.type.prompt / hooks.prompt.label / hooks.prompt.placeholder / hooks.prompt.preview
hooks.blocking.stopNote          // 上面那条"Stop 阻断 = 继续跑"的说明
```

★ **不进 i18n 的**（domain 值，按 AGENTS.md 那条）：判定条件原文、判定器返回的
`reason`、模型名、供应商名、`goal_status` 里的 `condition`。
这些是用户/模型产出的内容，不是 UI 文案 —— 翻译它们等于篡改证据。

### 6.4 遥测

按 CC 的字段名对齐（便于将来对照），落到本项目既有的遥测写入点：

| 事件 | 字段 |
|---|---|
| `goal_set` | `promptLength`, `origin`, `via ∈ 'user' \| 'proposal_direct' \| 'proposal_approved' \| 'restored'` |
| `goal_evaluated` | `outcome ∈ met \| not_met \| impossible \| error \| cancelled \| absent \| deferred`, `durationMs`, `iterations`, `origin`, `activeAgents` |
| `goal_cleared` | `reason ∈ user_clear \| superseded \| met \| impossible \| session_ended`, `iterations`, `durationMs`, `origin` |
| `goal_checkin_injected` | `trigger ∈ turn_end \| idle_timer`, `deferredMs`, `checkinCount`, `idleCheckinCount` |
| `goal_proposed` / `goal_proposal_decided` | `promptLength`, `askUser`, `decision` |
| `goal_idle_streak_stopped` | `streak`, `iterations` |

---

## 7. 分阶段实施

每一阶段结束时**应用可用、测试全绿**，不做"改到一半跑不起来"的中间态。

### P0 · hooks 类型扩展（不涉及 goal）

目标：`type: 'prompt'` 存在、设置页能配、能跑、能被 `Stop` 阻断；**还没有 goal**。

- `shared/domain/hook.ts`：判别联合、`HOOK_TYPES`、`HookFileEntry` 三个新可选字段、
  `Stop` 进 `BLOCKING_HOOK_EVENTS`、`PROMPT_HOOK_DEFAULT_TIMEOUT_MS`、`HOOK_PROMPT_MAX`
- `main/kernel/hook/load.ts`：`toDefinition` / `toFileEntry` 的分支与严格互逆
- `main/goal/evaluate.ts` **先建**：判定调用本身是纯的，P0 就能用 prompt 型钩子驱动
- `main/hooks.ts`：按 `hook.type` 分流到 `runHook` 或 `evaluatePromptHook`；
  新增 `runtimeHooks` 参数与运行期钩子表的接入点
- `main/hook-registry.ts`（新）
- `main/runtime.ts`：`Stop` 的那处调用改成**会看结果**（`void` → 有结果的、但仍不 await 的形态：
  把结果交给 `runHookEvent` 的调用方去决定，P1 会把它移到 `onTurnEnd`）
- `views/extensions/hooks/HooksPanel.tsx`：类型选择 + prompt 型字段 + 那条 Stop 说明

### P1 · 最小闭环（核心）

- `shared/domain/goal.ts`（新）、`shared/agent/message.ts` 加 `goal_status` part
  与第 2.3 节表里那七处同步改动
- `kernel/agent-session.ts`：`onTurnEnd` 缝、`toolCallsThisRun`、`stoppedTurnStreak`、
  `turn()` 的收尾改造（3.2）
- `main/goal/prompt.ts`（新）、`main/goal/state.ts`（新）、`main/goal/runtime.ts`（新）
- `main/runtime.ts`：装配 `onTurnEnd`（**只在 `agent === undefined` 的主 run 上装**）
- `shared/ipc/contract.ts`：`goal:get` / `goal:set` / `goal:clear` / `goal:changed`
- `views/chat/Composer.tsx`：`localActions` 支持参数与别名、接上 `/goal`
- `i18n`：`goal.*` 与 `composer.command.goal*` 那批键

★ 到这一步就是"能用"的：`/goal 让 bun test 全绿` → 每轮判一次 → 到绿为止。
状态用状态行 + 转录卡片看，暂时不做药丸面板。

### P2 · 恢复与后台延迟

- `main/goal/restore.ts`（新）+ attach / 会话打开时调用
- `main/goal/runtime.ts`：后台子代理查询、`deferredSince` / `checkinCount`、
  check-in 定时器（`unref()` + 显式 clear）+ `goal_checkin_injected` 遥测

### P3 · 模型自提目标

- `main/kernel/tool/builtin/goal.ts`（新）+ 注册进工具表
- `shared/agent/interaction.ts` 加 `goal_proposal` + `INTERACTION_SOUND`
- `views/chat/InteractionPanel.tsx` 加分支
- `settings.modelProposedGoals` 及其四处同步

### P4 · 设置与 UI 收尾

- `settings.goalEvaluatorModel` 及其四处同步 + 设置页那一栏
- `GoalPanel.tsx`、药丸、hooks 面板试运行的预览分支

### 文件清单汇总

**新增（8）**
```
src/shared/domain/goal.ts
src/main/goal/prompt.ts
src/main/goal/evaluate.ts
src/main/goal/state.ts
src/main/goal/runtime.ts
src/main/goal/restore.ts
src/main/hook-registry.ts
src/renderer/src/views/chat/GoalPanel.tsx
```

**修改（25）**
```
shared/domain/hook.ts            shared/domain/settings.ts
shared/domain/data.ts            shared/domain/config-sync-registry.ts
shared/agent/message.ts          shared/agent/interaction.ts
shared/agent/transcript.ts       shared/ipc/contract.ts
main/kernel/hook/load.ts         main/kernel/agent-session.ts
main/kernel/context-assembler.ts main/kernel/tool/builtin/index.ts
main/kernel/upstream/encode/anthropic.ts
main/kernel/upstream/encode/openai-chat.ts
main/kernel/upstream/encode/openai-responses.ts
main/hooks.ts                    main/runtime.ts
main/ipc/provider.ts             main/ipc/index.ts
renderer/src/stores/session.ts   renderer/src/i18n/index.tsx
views/chat/Composer.tsx          views/chat/StatusLine.tsx
views/chat/Thread.tsx            views/chat/InteractionPanel.tsx
views/extensions/hooks/HooksPanel.tsx
```

★ IPC 的处理器是**集中注册**在 `main/ipc/index.ts`（`'hooks:list': (req) => listHooks(req)` 那种写法，
见 505-510 行），不是每个域一个文件。所以 `goal:get/set/clear` 三条加在那里，
实现体放 `main/goal/runtime.ts`。

---

## 8. 边界情况（逐条给出预期行为，用来写测试）

| 情况 | 预期 |
|---|---|
| 条件为空 / 全空白 / 全是不可见字符 | 拒绝，**不设立**。规范化后为空即拒（照 CC：`whitespace and invisible characters`） |
| 条件 > 4000 字符 | 拒绝并给出实际长度。**不截断** |
| 条件恰好是 `clear` / `stop` / … | 当清除指令，不当条件 |
| 已有目标时再设 | 覆盖旧目标，旧的记 `superseded` 遥测；旧钩子**必须**先摘掉 |
| plan 模式下 `/goal` | 允许（它是用户明说的）；但 `ProposeGoal` **拒绝**——让模型先把计划走完 |
| 子 run 里 | 没有 `onTurnEnd`、没有 `ProposeGoal`、模型看不到目标的存在 |
| 判定器超时 | `skipped{timeout}`：不继续、不达成、不清除；诊断里留一条 |
| 判定器返回垃圾 JSON | `skipped{error}`，同上（**不是** `not_met` —— 那是把工具的故障算在用户的目标头上） |
| 判定器没有配置模型 | 回落到本次 run 的模型；连 run 模型都拿不到 → `skipped{no_model}` |
| 转录为空 | `skipped{transcript_empty}`（正常路径下不会发生，防御性） |
| 连续空转 8 次 | 强制收尾 + 一条 warning；目标**保持挂着**（不清除——用户可能只是想让模型等着） |
| 空转 7 次之后模型调了一次工具 | streak 归零，重新计数 |
| 后台子代理在跑 | 本轮不判定，`iterations` **不**增加；注入 check-in（按退避） |
| 后台子代理结束后 | 回到正常判定；`deferredSince` / `checkinCount` 清掉 |
| 空闲 check-in 到 3 次 | 不再注入，只重装定时器；最后一条带"不再自动唤醒"的说明 |
| 应用退出 / 会话删除 / run 被 abort | 定时器 clear、运行期钩子 clear、`ActiveGoal` 清掉 |
| 重载后 | 从转录恢复目标（`iterations: 0`），**不自动开跑** |
| 重载后转录里最后一个目标是已达成 | 不恢复（那个目标已经结束） |
| 用户手动 abort 一次 run | 目标保持挂着。判定只在 `end_turn` 那条路上发生，abort 根本不经过它 |
| 上游报 401 / 余额不足 | 目标保持挂着（本次决定不做"不可恢复错误自动清除"） |
| 同一个 session 先后设了三个目标 | 转录里三条 `goal_status` 标记；恢复只认最后一个 |
| `goalEvaluatorModel` 指向一个已被删除的供应商 | `ipc/provider.ts` 的成对修复会清掉配对；运行期回落到 run 模型 |
| 用户在 run 跑着的时候改判定器设置 | 本次 run 用**开始那一刻冻结**的那一对（同 `runtime.ts:1804` 的理由） |
| `goal_status` 要挂的那条消息是用户消息 | 只发 `goal:changed` 广播，不进转录（两轨必须分开，见 3.2 末段） |
| 转录为空时收到 `goal_status` | 防御性放弃，不抛（`index = -1` 那条路径） |
| 上游某家不支持空 content / 严格校验块类型 | `goal_status` 挂在已有消息上，**不新增任何上行消息** —— 这是这条设计要守住的不变量，用一条编码器单测钉住（断言上行消息数不变） |

---

## 9. 测试与验证

### 9.1 单测（`vitest run`，纯函数优先）

- `shared/domain/__tests__/goal.test.ts`：条件规范化、清除词、长度上限、`GoalVerdict` schema 的容错解析（围栏、多余文字、缺字段、类型错）
- `main/kernel/__tests__/goal-evaluate.test.ts`：注入假 stream → 四种 `GoalVerdict` 各一条；转录预算裁剪（造一个超预算的转录，断言被裁 + 前缀出现 + 前缀里那句 `insufficient evidence`）；超时；`prompt_too_long` 后按 0.5 预算重试
- `main/kernel/__tests__/goal-restore.test.ts`：反扫的四种情形（无标记 / 已达成的标记 / 未达成的标记 / 多条标记）
- `main/kernel/__tests__/hook-load.test.ts`（**已有文件，加用例**）：prompt 型条目的读写互逆、缺 `prompt` 被丢弃、老文件（无 `type`）仍解析成 command
- `main/kernel/__tests__/agent-session-goal.test.ts`：注入假 `onTurnEnd` ——
  `continue` 时提交 internal 用户消息并再次请求；`finish` 时收尾；
  **回调抛异常时按正常收尾**（这条最容易写错成死循环）；
  `toolCallsThisRun` / `stoppedTurnStreak` 的累加与复位；
  **`attachGoalStatus` 之后上行消息数不变**（把 `messages` 过一遍编码器，
  断言 `goal_status` 那条不会变成一条零内容块的消息）
- `main/__tests__/goal-runtime.test.ts`：连续空转刹车、后台延迟、退避计算、
  定时器在 abort 后被 clear（用假的 clock/timer 端口，**不要**真等 30 分钟）

### 9.2 端到端手测（`npm run e2e` 之后人工）

1. `/goal 把 src/shared/domain/goal.ts 里的 TODO 全部清掉` → 模型动手 → 全清掉 → 自动收尾、卡片显示"已达成"
2. `/goal 让一个永远失败的测试通过` → 观察：连续 8 次空转后被强停，warning 可见，目标仍挂着
3. 设目标 → 立刻 `/goal clear` → 卡片"已清除"，下一次 `end_turn` 不再判定
4. 设目标 → 关掉应用 → 重开 → 状态行显示目标还在、轮数是 0、**没有自动开跑**
5. 设目标 → 派一个 `run_in_background` 子代理 → 回合末不判定（转录里出现 check-in）
6. hooks 设置页配一条 `Stop` + `prompt` 型钩子（`只有当 README 里的版本号与 package.json 一致时才算达成`）→ 验证它真的挡住了收尾
7. 模型自提目标：说一句"我想让测试全绿" → 模型调 `ProposeGoal` → 弹窗批准 → kickoff 注入

### 9.3 命令

```
npm run typecheck     # 两套 tsconfig 都要过（新 part 类型会让编码器那三处漏改直接暴露）
npm run lint
npm test
npm run build         # typecheck + electron-vite build
```

★ `npm run typecheck` 是本次**最重要的一道闸**：`goal_status` 是判别联合的新成员，
`switch` 上带 `never` 兜底的地方（`transcript.ts` / `data.ts` / 编码器）会直接报错；
而没报错的那几处（`estimatePart`、`Thread.tsx` 的渲染分支）正是第 2.3 节表里
标了"漏掉会静默出错"的那几个 —— 所以**改完必须逐条对照那张表**，不能只靠 typecheck。

---

## 10. 本次明确不做

| 不做 | 理由 |
|---|---|
| `Bash` 的 `run_in_background` / `BashOutput` / `KillShell` | 用户在问询里已确认只算后台子代理。它本身是一个独立功能（进程登记、输出回读、终止、资源清理），塞进 goal 会让这次改动失去边界 |
| 目标的总迭代上限 / 费用预算闸 | 用户只选了连续空转上限。连续空转已经覆盖唯一的真死循环形态，总轮数上限只会误伤收敛中的长任务 |
| 不可恢复错误自动清除目标（CC 的 `HGn`） | 同上，用户未选。当前行为：目标保持挂着，用户自己决定 `clear` 还是继续 |
| 给 `CanonicalRequest` 加 `responseFormat` 结构化输出 | 判定走"JSON 契约写进 prompt + 容错解析"，跨供应商一致。加 `responseFormat` 会影响所有请求的编码路径，收益不等于风险 |
| `/goal` 非交互（`-p` / SDK）形态 | 本项目的 run 入口目前只有渲染层一条。等 SDK 那条通道确定之后再补，判定与状态那两层已经为此留好了缝（`main/goal/` 不依赖渲染层） |
| 目标进系统提示词 | 目标通过 kickoff / 续跑 / check-in 三条真实消息让模型知道，和 CC 一致。放进系统提示词会让 `lastReason` 每轮变化 = 每轮重破一次 prompt cache |
| `goal_status` 进模型上下文 | 它只是 UI 那一轨的标记（同 `{type:'error'}`）。回传给模型会让它开始为自己的历史成绩辩解 |






