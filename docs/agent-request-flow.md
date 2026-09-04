# Agent 请求流转协议

> 本文档描述一次 Agent 对话请求从 **渲染进程** 发起,经 **主进程** 调度、**推理引擎子进程** 执行、**本地模型网关** 转发,直至 **上游 Provider** 的完整流转路径,以及流式回填、人机交互(工具授权 / 反问)、取消与会话映射机制。
>
> 相关文档:`ipc-protocol.md`(IPC 交互协议)、`model-gateway-protocol.md`(本地网关接口协议)。

---

## 1. 参与方

| 角色 | 进程 | 职责 |
|------|------|------|
| UI | 渲染进程 | 发起 `agent:query`、渲染流式结果、响应授权/反问;**不做任何模型 HTTP 调用** |
| 调度器 | 主进程 | 组装运行环境、拉起引擎、解析流、回填 IPC、维护会话与取消 |
| 推理引擎 | 主进程 spawn 的子进程 | 执行 agent 循环,按 `ANTHROPIC_BASE_URL` 发起模型请求 |
| 本地网关 | 主进程内 HTTP 服务(`127.0.0.1:19836`) | 协议归一化、密钥注入、健康检查与故障切换(**可选**) |
| 上游 Provider | 远端 | 实际模型推理 |

**核心原则**:渲染进程是纯 IPC 客户端;所有模型调用发生在主进程侧(引擎子进程或主进程辅助 fetch)。网关是主进程内的可选中间层。

---

## 2. 全链路总览

```
渲染进程 (React)
   │  ① agent:query { conversationId, prompt, attachments, options }
   ▼  (Electron IPC，仅意图,无 HTTP)
主进程 (调度器)
   │  ② 解析会话上下文 → 组装 env(ANTHROPIC_BASE_URL / KEY)→ 选择模型/Provider
   │  ③ 拉起/复用推理引擎子进程
   ▼
推理引擎子进程
   │  ④ 按 env.ANTHROPIC_BASE_URL 发起请求
   │     代理开: http://127.0.0.1:19836/s/<sessionId>/v1/messages
   │     代理关: https://<provider-base>/v1/messages   (直连,绕过网关)
   ▼
本地模型网关 (可选)
   │  ⑤ 协议归一化 + 注入上游真实密钥 + 健康/failover
   ▼
上游 Provider ──⑥ SSE 流式返回──┐
                               │  (原路回传)
主进程 ◀── 网关 ◀── 引擎 ◀──────┘
   │  ⑦ 解析引擎输出(文本增量/工具调用/用量/状态)
   │  ⑧ webContents.send('agent:chunk', ...) 逐块推回
   ▼
渲染进程逐块渲染
```

---

## 3. 请求路径(下行)

### 3.1 渲染进程发起

```ts
// 渲染进程只发意图
await window.newmax.agent.query({
  conversationId,
  prompt,               // 文本 / 结构化输入
  attachments,          // 可选:图片、文件引用
  options,              // 模型、工具白名单等
});
// 底层: ipcRenderer.invoke('agent:query', payload)
```

### 3.2 主进程组装运行环境

主进程在拉起引擎前完成:

1. **会话上下文**:按 `conversationId` 装载历史、系统提示、工作区、已启用技能/工具。
2. **模型与 Provider 选择**:读取当前设置的模型别名与其所属 Provider。
3. **环境变量组装**(决定请求去向):

   ```js
   env = config.env ? { ...config.env } : { ...process.env, PATH: getExtendedPath() };
   // 关键项:
   env.ANTHROPIC_BASE_URL = <resolved base url>   // 见 §5
   env.ANTHROPIC_API_KEY  / ANTHROPIC_AUTH_TOKEN  // 本地网关鉴权 or 直连凭证
   ```

4. **拉起引擎**(主进程 spawn 子进程),把 `env` 注入运行环境。

### 3.3 引擎发起模型请求

引擎读取 `ANTHROPIC_BASE_URL`,向该地址发送标准协议请求(Anthropic Messages / OpenAI Chat 等,见 `model-gateway-protocol.md`)。**引擎不感知网关的存在**——它只认 base URL;是否经网关取决于该 URL 指向本地还是远端。

---

## 4. 响应路径(上行 · 流式)

1. 上游以 SSE(`text/event-stream`)流式返回;若经网关,网关做协议转换后透传。
2. 引擎解析事件流,产出结构化输出:文本增量、工具调用、思考过程、用量、停止原因。
3. 主进程消费引擎输出,归一化为 UI 事件,经 IPC 逐块推回:

   | 频道 | 方向 | 载荷 |
   |------|------|------|
   | `agent:chunk` | 主→渲染 | 文本/内容增量块 |
   | `agent:contextUsage` | 主→渲染 | 上下文占用 |
   | `agent:compactNotice` / `compactNoticeClear` | 主→渲染 | 上下文压缩提示 |
   | `agent:notify-completion` | 主→渲染 | 本轮完成 |
   | `agent:failover` | 主→渲染 | 网关发生 Provider 切换 |
   | `agent:isStreaming` | 主→渲染/查询 | 流式状态 |

4. 渲染进程按 `agent:chunk` 顺序拼接渲染。

---

## 5. Base URL 解析(网关开关)

`ANTHROPIC_BASE_URL` 的取值决定请求是否经过本地网关:

```
claudeProxyEnabled / failoverEnabled == true
        │
        ├─ 是 ──▶ getOrStartClaudeProxyBaseURL()
        │          → 无网关则 startClaudeProxy() 启动 127.0.0.1:19836
        │          → 返回 'http://127.0.0.1:' + proxyPort
        │          → 会话级: base + '/s/' + encodeURIComponent(sessionId)
        │          ⇒ ANTHROPIC_BASE_URL = http://127.0.0.1:19836/s/<sessionId>
        │
        └─ 否 ──▶ ANTHROPIC_BASE_URL = provider.settingsConfig.env.ANTHROPIC_BASE_URL
                   ⇒ 直连上游,绕过网关
```

| 模式 | base URL | 特性 |
|------|----------|------|
| 网关开 | `http://127.0.0.1:19836/s/<sessionId>` | 协议归一化、密钥托管、健康检查、故障切换 |
| 网关关 | `https://<provider>/v1` | 直连,延迟最低,无 failover |

**会话级路由** `/s/<sessionId>`:网关据此绑定该请求所属会话(`bindClaudeProxySession`),用于按会话选择 Provider、隔离健康统计与凭证。

---

## 6. 人机交互往返(Human-in-the-loop)

引擎在需要用户决策时暂停,主进程把决策通过 IPC 请求-应答抛给渲染进程,拿到结果再让引擎继续。

### 6.1 工具授权

```
引擎: 请求执行工具 X
  │
主进程: agent:tool-approval ─────▶ 渲染进程弹权限框
                                      │ 用户选择
主进程: ◀── agent:tool-approval-response {approve|deny, scope}
  │
引擎: 继续 / 跳过该工具
```

辅助频道:`agent:list-tool-approvals`(拉取待决项)、`agent:tool-approval-resolved`(已决通知)。

### 6.2 反问用户(Ask User)

```
主进程: agent:ask-user ─────▶ 渲染进程展示问题
主进程: ◀── agent:ask-user-response / agent:ask-user-dismiss
```

辅助频道:`agent:get-pending-ask-user`(重连时恢复挂起问题)。

> 授权/反问均为**阻塞式往返**:引擎在等待期间挂起,不产生新的 `agent:chunk`,直至渲染进程回传结果。

---

## 7. 取消与生命周期

| 频道 | 方向 | 作用 |
|------|------|------|
| `agent:cancel` | 渲染→主 | 中断当前轮:主进程终止引擎流并停止回填 |
| `agent:reset` | 渲染→主 | 重置会话运行态 |
| `agent:endSession` | 渲染→主 | 结束会话,释放引擎与会话绑定 |

**取消时序**:渲染 `agent:cancel` → 主进程中止引擎请求 / 关闭上游流 →(经网关时)网关中断上游连接 → 主进程发送终止态 → 渲染进程结束流式 UI。

---

## 8. 时序图(网关开 + 一次工具授权)

```
渲染         主进程            引擎(子进程)        本地网关          上游
 │  agent:query   │                │                 │               │
 ├───────────────▶│                │                 │               │
 │                │ 组装env/拉起    │                 │               │
 │                ├───────────────▶│                 │               │
 │                │                │ POST /s/<id>/v1/messages         │
 │                │                ├────────────────▶│  转发+注入key  │
 │                │                │                 ├──────────────▶│
 │                │                │                 │  SSE 流        │
 │                │                │◀────────────────┤◀──────────────┤
 │  agent:chunk   │◀───────────────┤ 解析增量         │               │
 │◀───────────────┤ (逐块)         │                 │               │
 │                │                │ 需要工具授权     │               │
 │ tool-approval  │◀───────────────┤                 │               │
 │◀───────────────┤                │                 │               │
 │ approval-resp  │                │                 │               │
 ├───────────────▶│───────────────▶│ 继续            │               │
 │  agent:chunk   │◀───────────────┤                 │               │
 │◀───────────────┤                │                 │               │
 │ notify-completion               │                 │               │
 │◀───────────────┤◀───────────────┤ 结束            │               │
```

---

## 9. 关键点速查

| 问题 | 结论 |
|------|------|
| Agent 在渲染进程运行吗? | 否。渲染进程只发 `agent:query`、收 `agent:chunk` |
| 渲染进程会直接调网关吗? | 否。渲染进程无模型 HTTP 能力,只配置 Provider/代理开关 |
| 谁真正调网关? | 主进程侧的引擎子进程(按 `ANTHROPIC_BASE_URL`),及主进程辅助 fetch |
| 网关是必经的吗? | 否。`claudeProxyEnabled/failoverEnabled` 开则经网关,关则直连上游 |
| 会话如何映射? | base URL 携带 `/s/<sessionId>`,网关据此绑定会话与 Provider |
| 流式如何回传? | 上游 SSE → 引擎解析 → 主进程 `webContents.send('agent:chunk')` → UI |
| 用户决策如何介入? | `agent:tool-approval` / `agent:ask-user` 阻塞式 IPC 往返 |
| 如何取消? | `agent:cancel` → 主进程中止引擎流 →(经网关时)断开上游 |
