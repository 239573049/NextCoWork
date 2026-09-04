# 05 · 上游子系统 `src/main/kernel/upstream`

> 模型调用的完整链路：**canonical 规范格式 → 路由治理（router）→ 编码（encode）→ SSE 解析（sse）→ 解码（decode）**，外加内置演示上游（demo）。
> 文件头（`router.ts:1-8`）：「归一化与治理是一个纯模块，内核在进程内直接调它，HTTP 网关（步骤 13）只是同一个模块上的一层薄协议壳。」

| 文件 | 行 | 一句话 |
|---|---|---|
| `canonical.ts` | 53 | 内部规范请求 = Anthropic 形状 + `joinUpstreamUrl` |
| `router.ts` | 337 | 候选集 / 健康评分 / 冷却 / 重试切换 / 协议分发 |
| `sse.ts` | 179 | SSE 分帧解析（全部难度在分块边界） |
| `encode/anthropic.ts` | 164 | canonical → Anthropic Messages 请求体 |
| `decode/anthropic.ts` | 278 | Anthropic SSE → canonical 流事件 |
| `demo.ts` | 642 | 演示上游：真 SSE、假网络、像真上游一样挑剔 |

## 1. `canonical.ts` —— 规范形状就是 Anthropic 形状

`CanonicalRequest`（`:18-34`）：`model`（★ 是 `ModelAlias.alias`，不是上游真实模型名，翻译在路由器）、`system`、`messages: AgentMessage[]`、`tools: ToolInfo[]`、`maxOutputTokens`、`thinkingBudget?`、`temperature?`、`stopSequences?`。

★ 选 Anthropic 而不是 OpenAI 作为规范形状（`:4-13`）：块模型 → 扁平字符串**有损**，反向无损。一个带 thinking 签名和并行 tool_use 的响应，降成 OpenAI 形状再升回来会丢 signature、丢块序。它把「3 入站 × 3 上游 = 9 组转换」因式分解成四组各 3 个小函数（当前只实现 anthropic→anthropic，其余协议返回明确的「步骤 13 未实现」错误而非诡异 400）。

`joinUpstreamUrl`（`:48-53`）：削尾斜杠、path 补前导 `/`、base 以 `/v1` 结尾且 path 以 `/v1/` 开头则去重。★ 自我标注「协议 §8 的 URL 拼接规则是个**会咬人的启发式**」—— 规则不可能对所有 baseUrl 都对，所以设置页必须把最终 URL 显示给用户确认；收口到这一个函数是为了显示行与实际请求用同一份逻辑。

## 2. `router.ts` —— 治理

常量（`:22-26`）：`MAX_ATTEMPTS=3`（含首次）、`DEFAULT_BASE_DELAY_MS=500`、`UNHEALTHY_AFTER=3`、`COOLDOWN_MS=30_000`。

### 2.1 候选集（`:120-145`）

- 按 `alias.alias === model` + `provider.enabled` 匹配，`priority` 升序 —— **同 alias 多 provider 正是别名表存在的理由**。
- ★ **旁路开关（`settings.gateway.failover`）落在路由器，不落在 HTTP 壳**（`:33-38`）：内核和网关都受这一个开关支配，不会出现「UI 里的对话有 failover、外部 SDK 调进来没有」的分裂。
  - 关：`slice(0,1)` 直取最高优先级，不做健康评分不做切换；
  - 开：先过滤掉冷却中（`cooldownUntil > now`）的，再按「优先级优先、同优先级内按 `health.score` 降序」排序 —— ★ **优先级是用户的显式意图，不被评分推翻**。
- `ProviderConfigSource` 的 `providers()/aliases()/failoverEnabled()` 是**函数而非快照** —— 设置页改完立刻生效，不必重建路由器。

### 2.2 健康记账（`:147-178`）

成功：`score = min(1, score*1.5 + 0.1)`（恢复比衰减快，但需多次成功才回 1 —— 一次侥幸不抹掉连挂三次）、清 failures/cooldown、记 `lastLatencyMs`。失败：`score *= 0.5`、failures+1；≥3 次 → `healthy=false` + 冷却 30s（到期自动重回候选）。

### 2.3 重试与切换的硬边界（`:261-318`）

★ **只能在收到第一个内容字节之前切换或重试**（`:294-303`）：一旦上游已吐 500 个 token 和一个 tool_use 块，换 provider 重来会产生重复输出与错位的工具调用 —— 之后的失败是硬错误，由用户决定重发。「这五行事后补要重写整个流式路径。」

★ `sawContent` 的定义（`:52-65`）：`message_start` **不算**（不携带内容，此时重试不会重复输出）；`text/thinking/tool_call/block_opaque/message_end` 算。

- 每候选至多 3 次；`canRetry = error.retryable && attempt < MAX_ATTEMPTS-1`；延迟 `retryAfterMs ?? baseDelay * 2^attempt`。
- ★ **尊重 `Retry-After` 不是礼貌问题**（`:70-80`）：限流期间按自己的退避表硬撞只会让冷却期不断延长（很多上游把限流期间的请求也计入配额）。
- 每次重试/切换前 yield `provider_retry` / `provider_switch` —— 没有它们用户看到的就是白白冻结 30 秒。
- ★ **auth 错误被记忆，最终优先上报 auth 而非最后一个 network 错误**（`:291,317`）—— auth 有明确行动指引（跳设置页）。
- ★ **重试放在路由器，绝不放在 session**（`:257-260`）：放在 session 会重放已经执行过的工具调用。
- 失败以**终止事件**而非异常表达（`yield {type:'error', …}`）；中断除外 —— reject 抛 AbortError 而非变成 error 事件（否则 UI 弹假失败提示）。
- 单次 `attempt`（`:186-255`）：未实现协议 → 明确错误；`secrets.get(credentialRef)` 为空 → `auth` 不重试且**不发请求**直接切下一个；非 2xx 时**必须读完 body**（否则连接不释放），JSON 解析失败就把原文交给分类器（网关 HTML 页）；`fetch` 抛错归一为可重试 `network`。

`noCandidateError` 三态措辞（`:320-336`）：别名未配置（不可重试）/ 全部停用 / 全在冷却（`retryable: true`，稍后自动恢复）。

## 3. `sse.ts` —— 分块边界

★ 「全部难度在分块边界」（`:7`）：本机低延迟时一个 chunk 常装下一整个事件，任何写法都「能跑」。`SseParser` 是**类**而非生成器，因为它有跨调用状态（半行缓冲 + 半个事件）—— 藏起来后没法单独测「上一块留了什么」。

| 规则 | 后果（若做错） |
|---|---|
| ★ 缓冲末尾的孤立 `\r` **不当行尾**（`:55-58`） | 它可能是被切开的 `\r\n` 前半；当成行尾则下一块的 `\n` 变空行 = 事件边界，每个跨块 `\r\n` 凭空劈出一个空事件 |
| BOM 只在流首削一次（`:37-41`） | 第一个字段名成 `﻿event`，整个 message_start 被当未知字段丢掉 |
| 冒号后**恰好一个**空格去掉 | 多余空格是数据 |
| `:` 开头注释行（心跳）静默忽略 | |
| `retry:` 字段不用 | 重试策略由 UpstreamRouter 的健康度决定，不该被上游一句 `retry:` 改写 |
| 只有 `event:` 没有 `data:` 的事件按规范丢弃，但**事件名要重置** | 否则粘到下一个事件上 |
| `flush()` 交出末尾未以空行结束的事件 | 规范说要丢，但上游经常这么干；交出来让「少一个空行」不至于变成「最后一个事件丢了」 |

`sseFromResponse`（`:151-179`）三件事：

1. ★ **`TextDecoder({stream:true})` 不是可选的**（`:146-150`）：一个 3 字节中文字符横跨两块时逐块 `toString()` 会在接缝产生 U+FFFD，症状是「中文回复里偶尔冒一个 �」且位置取决于网络分片永无法复现；
2. 每次 `read()` 前显式查 `signal.aborted`（fetch 的 signal 不会让已在途的 read 立刻回来）；流结束后无参 `decoder.decode()` 冲掉残留半字符再 `parser.flush()`；
3. ★ finally `reader.cancel()`（`:175-178`）：不 cancel 则 socket 挂着，上游仍在发 token 只是没人读。

## 4. `encode/anthropic.ts` —— 映射规则

- ★ `signatureOf`/`redactedOf` 只读 `ContentPart.opaque.signature` / `.redacted` 一个键（`:17-33`）：两侧只碰 opaque，内核其余部分对它一无所知 —— 「透传逃生舱：我们负责搬运，不负责理解」。
- `toBlock` 返回 null = 不上行，每种都是故意的：
  - `text`：★ **空 text 块是 400**（`text content blocks must be non-empty`），很容易产生（中断在第一个 delta 之前、模型直接以 tool_use 开场）→ 丢弃；
  - `thinking`：`opaque.redacted` → `{type:'redacted_thinking', data}`；★ **没有 signature 的 thinking 块不能回传**（Anthropic 拒 `thinking blocks require a signature`）—— 丢整块比带假签名安全：丢只是少一段推理上下文，假签名是 400 整轮废；
  - `tool_call` → `tool_use{input: input ?? {}}`（undefined 会被 JSON.stringify 掉变成缺字段）；`tool_result` → `tool_result{content, is_error}`；
  - `subagent`/`image`/`error` → null。★ error part 不上行：「回传给模型，模型就会开始为我们的 bug 道歉」。
- `toAnthropicMessages` 两条踩出来的规则：① 空 content 的消息整条跳过（空 content 是 400）；② **相邻同角色消息合并** —— 并行工具结果或中断补偿会产生两条连续 user，Anthropic 要求严格交替。
- `toAnthropicTools`：★ 下发 `externalName`（不是 internalId），反向解析在 `ToolRegistry.resolveByExternalName`；字段名 `input_schema`。
- `encodeAnthropic`：`stream:true` 恒真；`system`/`tools`/`stop_sequences` 非空才发。thinking：`thinkingBudget !== undefined` → `{type:'enabled', budget_tokens}`；★ **开 thinking 时 `max_tokens` 必须 > `budget_tokens`**，不足抬到 `budget_tokens + 4096`；**且开 thinking 不接受 temperature**。headers：`x-api-key`（不是 `Authorization: Bearer`）+ `anthropic-version: 2023-06-01`，path 恒 `/v1/messages`。

## 5. `decode/anthropic.ts` —— 事件映射

文件头定调（★ `:8`）：对**畸形输入**统一态度是**跳过，不抛** —— decode 循环里的 throw 会穿过 router、穿过 session，最后变成「run 无声消失」，而起因可能只是上游多发一行 `data: [DONE]`；真正的致命错误走显式 `error` 事件。

| 事件 | 规则 |
|---|---|
| 通用 | ★ **以 `data.type` 为准，不以 `event:` 字段为准**（`:133-135`）—— 两者在 Anthropic 一致，但中间隔一层兼容网关时 `event:` 更容易被改写或干脆不发。`[DONE]`/非对象 JSON 跳过 |
| `message_start` | 取 `input_tokens` 与两个 cache 字段；yield `message_start{model}`（缺省 `<unknown>`） |
| `content_block_start` | `tool_use` → `tool_call_start`（id 缺失兜底 `call_${index}`）；`redacted_thinking` → ★ 整块不透明、零 delta、一次到位 `block_opaque{opaque:{redacted}}` —— **必须原样回传，否则下一轮 Anthropic 认为思考链被篡改** |
| `content_block_delta` | `thinking_delta` 读 **`thinking` 字段不是 `text`**；★ `signature_delta` **累积**（`signatures.set(i, prev + s)`）—— 签名可能分多个 delta 到达，攒到 `content_block_stop` 才发；`input_json_delta` → `tool_call_delta`，★ callId 缺失说明漏了 start，**丢掉这个 delta 好过编一个 callId**（编出来的 id 回传时匹配不上任何 tool_use，直接 400） |
| `content_block_stop` | 有签名 → `block_opaque{opaque:{signature}}`；tool_use → `tool_call_end` |
| `message_delta` | 更新 stopReason；★ **`output_tokens` 是累计值不是增量 —— 直接赋值不 `+=`**（`:246-250`）：上游多发一条 message_delta（带 stop_sequence 时会）成本就翻倍且静默 |
| `message_stop` | `message_end{stopReason, usage}` |
| 流末尾 | ★ `sawStart && !sawEnd` = 连接被中途掐断 → 补一条 `network` 可重试 error。不补则 session 等一个永远不来的 message_end，表现是「回复停在半句话上，转圈不停」；中断走 throw 不会到这里；★ 空流不补（那是 router 的事） |

错误分类 `anthropicErrorToAgentError`（`:66-95`）：401/403 → `auth` 不可重试；429 → `rate_limit`；400 时 ★ 用 message 正则认出 `context_length`（「prompt is too long」等）不可重试 —— 认出来 UI 才能提示 /compact，认不出来用户只看到一句没有行动指引的 invalid request；其余 400 → `provider` 不可重试；529 或 ≥500 → `provider` 可重试。流内 `event: error`（HTTP 已 200）同理。★ 未知 `stop_reason` 映射成 `end_turn` 而不是抛错 —— 上游随时加新停止原因（`pause_turn` 就是后来加的），多一个不认识的不该让这一轮失败，内容已经收到了。

## 6. `demo.ts` —— 演示上游（642 行）

定位（★ `:4`）：**真 SSE、假网络**，挂在 `KernelHost.fetch` 上，不是挂在 `UpstreamRouter` 里的 `if (isDemo)` —— 请求照样经 `encodeAnthropic`、响应照样是 SSE 字节流、照样过 `SseParser` → `decodeAnthropic` → 健康评分。**演示与真实之间没有一条分叉的代码路径**，消灭「dev 里好好的，填了真 key 就崩」。

它做两件假发射器永远不做的事（`:11-19`）：

1. **按字节切片不按事件切片**（`renderDemoSse` 的 `pieces` 按码点切不按 UTF-16 码元，否则 emoji 劈成半个代理对）—— 让 sse.ts 那两个 bug 每次 dev 都必然发生；
2. **像真上游一样挑剔** —— `validateAnthropicRequest`（`:94-230`，导出供单测直接喂）逐条复刻真 Anthropic 的 400：空 text 块、无 signature thinking、角色不交替、工具名超 64、调用未下发的工具、★★ **每个 tool_use 必须在紧随的下一条消息里配对 tool_result**（含末尾悬空）—— 中断收尾漏掉补偿时真上游的 400 指向消息数组，读起来像 adapter bug，起因却在几百行外的 abort 路径。

细节：

- 常量：`DEMO_PROVIDER_ID='demo'`、`DEMO_MODEL='demo-model'`、`DEMO_ALIAS='nextcowork-demo'`、`DEMO_CREDENTIAL_REF='demo:api-key'`（**走 safeStorage 同一条取值路径**，不是明文特例）、`baseUrl='https://demo.invalid'`（保留 TLD，永不撞真域名）、priority 100。
- `planDemoReply`：thinking 开 → 先推一块 thinking（signature `demo-signature-${seq}`，跑通 signature 往返）；上一条有 `tool_result` → 回一句「工具回来了：…」**收工**（★ 不收工的话 dev 里每次发送都一路撞到 MAX_TURNS 25 轮，看起来像死循环）；有 tools → text + `tool_use{input: 按 schema 前 4 个字段编值}`；否则纯文本。
- `renderDemoSse`：回**请求里的** model 名；发一个 `ping`（让 decode 的忽略分支每次 dev 都被走到）；★ signature **分两帧**发（decode 的累加逻辑只发一帧等于没测）；★ tool_use 入参 JSON **切碎成 11 字符一片**（每一片单独看都是非法 JSON —— 正是「只在 tool_call_end 时 parse 一次」规则的由来）。
- `sseStream` 用 `pull` 而不是在 `start` 里一次推完 —— 一次推完背压是假的，且中断只能在下次 read 时才被发现；`pull` 开头查 `signal.aborted` 即 `throw abortError()`（★ 若写成 `new Error`，用户点停止会收到假「网络错误」）。
- `demoFetch`：认 string/URL/Request 三种入参形态（Request 那路最易漏）；只认 `POST …/v1/messages`（其余 404 —— 拼错在真上游是 HTML 404 页、在这里是句能读的话）；缺 `x-api-key` 401（router 分类成 auth → UI 跳设置页）。
- ★ **挂接分派依据是主机名，不是全局「演示模式」布尔**（`:599-617`）：全局开关会让真上游也收到假回复。`withDemoSecrets` 只劫持 `demo:api-key` 一个 ref（同时配演示 + 真上游的 dev 环境不该被顶掉真密钥）；`demoHost()` 用 `demoFetch` 本身当 fetch —— 无头测试里一个写错 baseUrl 的请求得到演示 404 而**不会漏到真网络**。

## 7. 测试固化行为

- **sse.test.ts**：★ **逐字符分片（n=1,2,3,5,7,13,64）结果与一次性喂完全一致**；`\r\n` 被切开不产生幽灵事件；三种行尾；BOM 只削流首；注释忽略；flush 交出尾巴事件；多字节 UTF-8 横跨 chunk 不产生 U+FFFD（刻意在第一个汉字 3 字节中间切开）；提前 break 时底层 reader 被 cancel。
- **encode-anthropic.test.ts**：丢空 text 块/变空的整条消息；合并相邻同角色（3 条 user → 1 条 3 块）；丢无签名 thinking、带签名原样回传、`redacted_thinking` 正文空也回传；opaque 形状坏按无签名处理不崩；`input` 缺失补 `{}`；error part 不上行；tools 下发 externalName；thinking 抬 `max_tokens`、开 thinking 不发 temperature；`joinUpstreamUrl` 6 组边界。
- **decode-anthropic.test.ts**：最小完整流精确事件序列；零 delta 仍有 start+end（无参工具）；并行工具靠 index 不串台；无 start 的 delta 丢弃而非伪造 callId；signature 累积；多条 `message_delta` 取最后一个不累加；未知 stop_reason 退化 `end_turn`；`[DONE]`/`42`/`"x"`/`null`/未知事件跳过；缺 `message_stop` 补可重试 network 错误、完整结束不补、**空流不补**；错误分类全表（含 418+HTML 仍给出含状态码的 provider 错误）。
- **router.test.ts**：★ **首字节边界**（本文件最重要）：发内容后断流 → 只有 1 次 text_delta、无 retry/switch、末尾硬 network 错误、**只发了 1 次请求**（第二个 provider 根本没被碰）；反面 —— 无内容时同样错误会重试；只收到 `message_start` 仍可切换。3 次尝试 = 2 次 retry 后切换且顺序 `[retry, retry, switch]`；候选中出现过 auth 优先报 auth；缺密钥的 provider 不发请求直接切；尊重 `Retry-After`；连败 3 次进冷却、到期自动恢复、`resetHealth` 立刻解除；★ 健康度只在同优先级内排序；旁路模式失败不切换；中断抛 AbortError 而非 error 事件。
- **demo.test.ts**：`validateAnthropicRequest` 全表（★ 孤儿/悬空 tool_use、无 signature thinking、`max_tokens ≤ budget` 等）；端到端 `text_delta` 多于 1 次（一次性发完就看不到流式滚动）；★ **先证明危险是真的**（逐块 `Buffer.toString()` 确实产生 U+FFFD）再证明流水线中文一个字不少；入参 JSON 切碎（deltas >1 且至少一片单独 parse 失败）；签名确实分两帧；HTTP 层 401/400/404/405 全表；400 不白白重试三次；★ 非演示 URL 落到真 fetch、演示 URL 零出网；中断两路径都抛 `isAbortError` 认得的错；★★ **接进 AgentSession 的验收段**（`:691-782`）：ContextAssembler → encode → 假网络 → SSE → decode → Router → think→tool→observe 循环 → ToolRegistry **全程零 mock 零打桩，唯一不真的东西是那根网线**。

## 8. ★ 不变量速查

1. `canonical.model` 是 alias 不是上游模型名（`canonical.ts:19`）。
2. 只能在第一个内容字节之前重试/切换；`message_start` 不算内容（`router.ts:46,294`）。
3. 重试在路由器不在 session；auth 优先上报。
4. 旁路开关落在路由器不落 HTTP 壳；健康度只在同优先级内排序。
5. SSE 三件事：孤立 `\r` 不当行尾；`TextDecoder({stream:true})` 必须用；提前退出 `reader.cancel()`。
6. 开 thinking 时 `max_tokens > budget_tokens`（不足 +4096）且不发 temperature。
7. decode 对畸形输入跳过不抛；`output_tokens` 累计值直接赋值。
8. 空 text/空 parts/无签名 thinking/未配对 tool_result 都是 400 —— 三层防线（assembler/encode/demo）各拦一道。
9. 演示上游挂 `KernelHost.fetch`、按主机名分派，没有全局演示布尔。
