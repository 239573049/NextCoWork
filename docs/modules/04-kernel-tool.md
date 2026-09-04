# 04 · 工具子系统 `src/main/kernel/tool`

> 工具框架五件事：**定义**（zod 一次写三用）、**命名**（双名机制）、**注册**（唯一收口点）、**路径围栏**、**内置工具**。

| 文件 | 行 | 一句话 |
|---|---|---|
| `define.ts` | 73 | `defineTool`：zod schema → JSON Schema + 入参校验 + 异常收敛 |
| `naming.ts` | 113 | externalName 生成：消毒 / 截断 / FNV-1a 哈希去重 |
| `registry.ts` | 157 | 注册表：注册 / 替换 / 快照过滤 / 按源下线 |
| `path-guard.ts` | 105 | `resolveInWorkspace`：工作区路径围栏的唯一入口 |
| `builtin/echo.ts` | 60 | 内置工具唯一成员（试金石） |

## 1. `define.ts` —— 一个工具怎么定义

收口三件事（`:1-14`）：① 用 zod 写一遍 schema、`z.toJSONSchema` 导出给模型（手写 JSON Schema 会与解析逻辑分叉）；② 校验模型生成的 `unknown` 入参；③ 异常收敛为 `tool_failed` 结果进转录并继续循环，而不是打死整个 run。

```ts
ToolSpec<S extends z.ZodType> {          // define.ts:21-31
  internalId: string                     // 规范名（mcp__… 不限长）
  description: string                    // 注册时被消毒 + 限长 4096
  schema: S
  readOnly: boolean                      // plan 模式可用性 + 将来并行调度资格
  destructive: boolean                   // 权限档位（§4.5 五行表）的入参
  source?: ToolSource                    // 缺省 {kind:'builtin'}
  run(input: z.output<S>, ctx): Promise<ToolResult>
}
```

- `toJsonSchema` 剥 `$schema`（`:34-37`）—— 对上游无意义但每次请求都付 token。
- `explain` 把 zod issues 压成一行 `path: message; …`（`:40-47`）—— **模型靠这句话决定怎么重试**。
- `execute`：`safeParse` 失败 → `toolFail('参数不合法 —— …')` 不抛；`run` 抛错时 ★ **`isAbortError` 原样 rethrow**（`:66-67`）—— 伪装成工具失败的话，模型看到「工具失败」会继续往下跑，用户点了停止对话还在动；其余（含非 Error 值）→ `toolFail('工具执行失败:…')`。

## 2. `naming.ts` —— 双名机制

背景（`shared/agent/tool.ts`）：Anthropic 限制 `^[a-zA-Z0-9_-]{1,64}$`。`mcp__github-enterprise-internal__create_pull_request_review_comment` 是 66 字符，换来一个只说 "invalid tool name" 的 400 —— 而那时你会先怀疑自己的 schema。

- `fnv1a32`（`:22-30`）：手写 FNV-1a 32 位。★ **刻意不 `import node:crypto`** —— 内核要能在任意 JS 运行时跑；哈希只用于去重，无安全属性。
- `sanitizeToolName`（`:38-44`）：白名单替换（非 `[a-zA-Z0-9_-]` → `_`）、`_{3,}` → `__`（保住 `mcp__server__tool` 双下划线约定，又不让全中文名变 40 个下划线）、空串兜底 `'tool'`。输入是 MCP server / Skill 自声明的**不可信名字**，白名单而非黑名单。
- `sanitizeDescription`：`stripControlChars` + 4096 截断。描述直接进系统提示词，是投毒入口 —— 限制拦不住投毒（那靠权限层），拦得住「200KB 描述挤爆上下文」。
- `ToolNamer`（`:68-108`）：双 Map（internal↔external）。`allocate` 三段：base ≤64 且未占用直接用 → `base.slice(0,55) + '_' + fnv1a32(internalId)` → 线性探测 `_1.._999`。
  - ★ **映射在一次会话内必须稳定**（`:8`）：哈希取自 `internalId`（不变量），不取注册顺序/时间 —— 已落盘的转录里存的是旧名字，重启后算出别的名字，历史里的 tool_use/tool_result 就再也配不上。
  - ★ **分配过的名字永不回收**（`:63`）：MCP 断开后历史 tool_use 仍引用旧名，同名先后指向两个工具更糟。

## 3. `registry.ts` —— 注册表

- `ToolContext`（`:18-29`）：`workspaceRoot` / **`signal`（★ 必填且必须真的传到 execute 体内 —— 只中断 HTTP 流会留下僵尸 shell 和还在写的文件）** / `permissionMode`（run 快照）/ `depth` / `callId` / `emit(progress)`（进度是易失的，永不进转录）。
- `Tool = ToolInfo + execute` **定义在 main 而非 shared**（★ `:34-38`）：`execute` 是闭包过不了 IPC；渲染层拿 `ToolInfo` 部分。不拆 Definition/Executor —— 只有定义要跨网络传输时才划算。
- `ToolRegistry`：`Map<internalId, Tool>`，插入顺序即快照顺序。
  - `register`（`:82-96`）：**唯一收口点** —— 生成并校验 externalName、消毒 description 都在这里。★ 重复 internalId 是**替换**不是报错（MCP 重连是正常路径）；因 externalName 由 internalId 记忆，替换后名字不变。
  - `unregisterBySource`（`:105-115`）：按 `builtin` / `mcp:{serverId}` / `skill:{skillId}` 批量下线。★ **正在执行的工具不被打断**（`:96-117` 测试钉住）：执行方在调用前就持有 `Tool` 引用，从 map 删掉不影响那个引用 —— 前提是执行方**不在完成时回注册表重新查找**（session 的 `byName` 正是为此）。
  - `snapshot(filter)`（`:123-132`）：`readOnlyOnly`（**plan 模式的真正实现**）与 `allowList`（Skill frontmatter `allowedTools`，internalId / externalName 两边都认 —— 让用户猜内部用哪个名字没有道理）是与关系；★ 每轮开始取一次且是**拷贝**（快照不随后续注册变化）。
  - `resolveByExternalName`：模型回传名字换工具的唯一入口；undefined = 「模型编的」或「本轮被下线」，调用方应当成工具错误而非崩溃。
  - `info(filter)`：剥 `execute` 才能过 IPC 结构化克隆（忘了剥是运行时 `DataCloneError`，类型检查一声不吭）。

## 4. `path-guard.ts` —— 路径围栏

★ **任何工具、任何 handler 碰工作区路径，唯一入口**（`:1-14`）—— 不许别处 `path.join(root, ...)`。五个朴素 join 拦不住的逃逸形态：

1. 词法逃逸 `../..`
2. 绝对路径被 join 当新根
3. 符号链接指向围栏外
4. macOS `/var` vs `/private/var`（两处「都正确」的根）—— 所以 `workspace:pick` 拿到路径后立刻 `realpathSync.native`（`ipc/workspace.ts:38-39`）
5. 大小写不敏感文件系统（darwin/win32 折叠比较；★ Linux 折叠会把两个**不同**目录当同一个，那是另一个方向的错）

关键实现：

- `resolveInWorkspace`（`:82-94`）：realpath 根 → join（绝对路径不特殊照顾）→ **两道检查缺一不可**：词法挡 `..`（目标可能不存在，realpath 帮不上忙）+ realpath 挡 symlink → 返回 realpath 后的绝对路径。
- `realpathOfDeepestExisting`（`:60-74`）：目标还不存在（写新文件）时向上退到最深的**存在**祖先再 realpath、尾巴 join 回来 —— 只 realpath 根不 realpath 目标等于没做。
- `PathEscapeError` 带 `attempted`/`root`：**逃逸是攻击不是错误**，上层要能分辨并单独记日志。
- `toWorkspaceRelative`：压回工作区相对、恒 `/` 分隔 —— 跨平台稳定 key，UI 永不出现用户绝对路径。

⚠️ `tool/__tests__/` 只有 define/naming/registry 三个文件，**path-guard 没有本目录内的测试**。

## 5. `builtin/echo.ts` —— 试金石

定位：步骤 4 的工具层试金石 —— 无 fs、无网络、无权限弹窗就能端到端跑通 `tool_use → 执行 → tool_result → 继续` 的链路形状。真实工具替换它，但链路形状不变，所以它**老实走** `defineTool`、发进度、认 signal。

- `EchoInput{text, delayMs?}`：`delayMs` 的存在就是为了验证**中断真的穿透到工具体内**。
- `sleep`（`:24-37`）：先查 `signal.aborted` 再挂 listener（`{once:true}`，超时前移除）。★ 工具里所有等待都必须长这样，否则 abort 留僵尸。
- `builtinTools()`（`:58-60`）：内置工具唯一清单入口 —— 步骤 9（fs/bash）、11（task）往这里加，避免「注册了哪些内置工具」散落在多个 setup 函数。

## 6. 测试固化行为

- **define.test.ts**：合法入参解析后交给 run；不合法返回 `isError` 结果而非抛出（`null/42/'str'/[]` 都不崩）；错误信息带字段路径；`throw '字符串'` 也收敛；AbortError 原样抛；剥 `$schema` 且保留 `type/properties/required/description`；schema 能 `structuredClone`；source 默认 builtin。
- **naming.test.ts**：中文→`__`、`_{3,}` 压缩、全非法→`tool`；描述保留 `\n\t` 削 `\u0000\u0007\u001B\u007F`；`fnv1a32` 恒 8 hex 且 500 输入互不相同；同 id 五次同名；超长名截 64 且带 `_[0-9a-f]{8}$`；**前 55 字符相同的两个长名不撞**；消毒后相同的两个短名不撞；300 批量分配全唯一。
- **registry.test.ts**：注册补全 externalName；重复 id 替换且名字不变；下线只动指定来源；**执行途中来源被下线不影响这次执行**（Promise gate 钉住「执行方持有引用」）；`readOnlyOnly` 过滤 = plan 模式；allowList 双名都认、空 allowList 一个不给；快照不随后续注册变化；编造名字 undefined；`info` 剥 execute 且可 clone。
- **echo**：原样返回；等待时进度内容精确；已中断 signal 立刻抛；`delayMs: -1/999_999` 是工具错误；builtinTools 含 echo 且 id 唯一。
