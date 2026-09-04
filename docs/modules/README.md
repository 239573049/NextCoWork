# 模块文档（以代码为准）

本目录描述 NextCoWork **当前代码**的实际架构 —— 与 `docs/` 根下的三份协议文档（`ipc-protocol.md` / `model-gateway-protocol.md` / `agent-request-flow.md`）不同：那三份是**协议层/目标态**文档，本目录描述实现，并在 [09 篇 §8](./09-engineering.md) 给出两者的完整核对表。所有断言都带 `file:line` 出处，写作时点为 2026-09-04（渲染层 `files` Tab 正在接线中）。

## 文档索引

| # | 文档 | 范围 | 一句话 |
|---|------|------|--------|
| 01 | [架构总览](./01-overview.md) | 全局 | 三层结构、依赖方向铁律、启动时序、一次 run 的全链路、实现状态总表 |
| 02 | [共享契约层](./02-shared-contract.md) | `src/shared` | 62 条 IPC 频道三张表、信封与 seq、Agent 领域模型、domain 子域 |
| 03 | [Agent 内核](./03-kernel.md) | `src/main/kernel` 核心层 | KernelHost、think→tool→observe 循环、RunRegistry 重放、上下文组装与压缩 |
| 04 | [工具子系统](./04-kernel-tool.md) | `src/main/kernel/tool` | defineTool、双名机制、注册表、路径围栏 |
| 05 | [上游子系统](./05-kernel-upstream.md) | `src/main/kernel/upstream` | canonical/router/sse/encode/decode + 演示上游 |
| 06 | [主进程外壳](./06-main-process.md) | `src/main`（除 kernel） | 启动时序、装配、合批泵、内存状态仓、定向推送、已知偏差清单 |
| 07 | [安全桥](./07-preload.md) | `src/preload` | 三个通用原语、四道防线、单文件打包因果、类型链 |
| 08 | [渲染层](./08-renderer.md) | `src/renderer` | stores 与事件泵、shell 布局、chat 视图、UI 组件库、settings 体系 |
| 09 | [工程化](./09-engineering.md) | 配置与脚本 | vite/builder 配置、vitest、双 tsconfig、变异测试、CDP e2e、文档核对表 |

## 阅读路径

- **第一次接触这个仓库** → 01（总览）→ 06 §4.2（合批泵）→ 03 §2（AgentSession）。
- **想理解一次对话怎么走完全程** → 01 §6 的全链路图，然后按图索骥各篇。
- **要改 UI** → 08（重点 §3 stores 的不变量与 §4 的 drag 区陷阱）。
- **要接新的 IPC 频道** → 02 §2（契约三张表）→ 07（preload 白名单自动生效）→ 06 §4.1（handler 注册与 `todo()`）。
- **要接真上游/排查模型请求** → 05（全篇）+ 03 §4（thinking 预算）。
- **要判断「文档说的功能为什么没有」** → 01 §7（实现状态总表）→ 06 §9 / 09 §8（偏差与核对表）。

## 贯穿全仓库的少数几条铁律

1. **依赖方向单向**：`renderer → preload → main → kernel → shared`，kernel/runtime 零 electron import（有测试报警）。
2. **订阅在前、启动在后**：runId 由渲染层 mint（ULID），事件永远不丢在「还不知道 runId」的窗口里。
3. **异常绝不穿过 `ipcMain.handle`**：错误分类（`AgentError.code`）是 UI 决策的唯一依据。
4. **每个 tool_use 必有配对 tool_result**（中断收尾、压缩、参数非法三个入口都守着它）—— 否则下一轮 400。
5. **同一个问题只答一次**：`isAbortError`、`envelopeFirstSeq`、`stripControlChars`、`abortError()` 都只存在于一个文件。
6. **演示与真实之间没有分叉的代码路径**：演示上游挂在 `KernelHost.fetch` 上按主机名分派。
