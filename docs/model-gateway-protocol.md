# 本地模型网关 · 接口协议

> 桌面应用在主进程内常驻一个**本地 HTTP 模型网关(Local Model Gateway)**,监听环回地址,对外提供 **OpenAI 兼容** 与 **Anthropic 兼容** 两套推理接口,内部负责把多家上游模型 provider 归一化为统一协议,并实现多 provider 健康检查与故障自动切换。
>
> 本文档描述该网关暴露的三套接口协议:**Anthropic Messages**、**OpenAI Chat Completions**、**OpenAI Responses**,以及上游归一化、鉴权、流式与控制通道。

---

## 1. 概览

```
                      ┌──────────────────────────────────────────┐
   本地调用方          │        本地模型网关 (127.0.0.1:19836)        │        上游 Providers
 (SDK / 工具 / 三方) ──┤                                          ├──▶  MiniMax / Qwen / GLM
   OpenAI 或 Anthropic │  入站协议归一化 → 路由 → 鉴权注入 → 转发     │      Kimi / DeepSeek / ...
   任一协议            │  健康评分 · 失败重试 · provider 故障切换      │   (各自 /v1/messages 或
                      │  流式回填 (SSE 透传/转换)                    │    /v1/chat/completions 或
                      └──────────────────────────────────────────┘    /v1/responses)
```

**定位**:一个「协议适配 + 负载治理」中间层。调用方无论用 OpenAI 还是 Anthropic 协议,都能透明访问任意配置的上游模型;网关负责协议转换、密钥注入、失败切换,屏蔽 provider 差异。

---

## 2. 服务模型与生命周期

| 项 | 说明 |
|----|------|
| 绑定地址 | `127.0.0.1`(仅本机环回,不对外) |
| 默认端口 | `19836`(`0x4d7c`);被占用时动态选端口,实际端口经 IPC 回传 |
| 传输 | HTTP/1.1,流式用 SSE(`text/event-stream`) |
| 启动 | 单例懒启动:已启动则复用,记录 `startedAt` / `totalRequests` / `lastError` |
| 状态同步 | `modelGateway:sync`、`modelGateway:getStatus`、`claudeProxy:getStatus`(见 §8) |

**404 自描述**:未匹配路由时返回

```json
{ "error": { "message": "Not found. Available endpoints: POST /v1/messages, POST /v1/chat/completions, GET /v1/models, GET /health" } }
```

---

## 3. 鉴权

网关同时兼容两种鉴权头,按入站协议选择:

| 协议 | 头 | 示例 |
|------|----|------|
| Anthropic | `x-api-key` + `anthropic-version` | `x-api-key: sk-...`,`anthropic-version: 2023-06-01` |
| OpenAI | `Authorization: Bearer` | `Authorization: Bearer sk-...` |

- 入站 key 用于**本地网关自身的访问控制**;网关向上游转发时会**替换为该 provider 配置的真实凭证**(`Authorization: Bearer <上游key>`),调用方无需知道上游密钥。
- 上游凭证由控制层管理(见 provider 通道),不落入调用方。

---

## 4. 端点目录(入站)

| 方法 | 路径 | 协议 | 说明 |
|------|------|------|------|
| POST | `/v1/messages` | Anthropic Messages | 见 §5 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions | 见 §6 |
| POST | `/v1/responses` | OpenAI Responses | 见 §7(上游支持;可由 `useResponsesApi` 强制走此协议) |
| GET | `/v1/models` | 通用 | 列出可用模型 |
| GET | `/health` | 通用 | 健康探针 |

---

## 5. Anthropic Messages 协议 · `POST /v1/messages`

### 5.1 请求

```http
POST /v1/messages HTTP/1.1
Host: 127.0.0.1:19836
Content-Type: application/json
x-api-key: <gateway-key>
anthropic-version: 2023-06-01
```

```jsonc
{
  "model": "claude-... | glm-... | qwen-... | 任意已配置模型别名",
  "max_tokens": 1024,
  "system": "可选的系统提示",
  "messages": [
    { "role": "user", "content": "你好" },
    { "role": "assistant", "content": [{ "type": "text", "text": "在" }] }
  ],
  "temperature": 0.7,
  "top_p": 1,
  "stop_sequences": ["\n\n"],
  "stream": false,
  "tools": [
    {
      "name": "get_weather",
      "description": "查询天气",
      "input_schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }
    }
  ],
  "tool_choice": { "type": "auto" }
}
```

`content` 支持字符串或 block 数组(`text` / `image` / `tool_use` / `tool_result`)。

### 5.2 非流式响应

```jsonc
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "...",
  "content": [
    { "type": "text", "text": "你好,有什么可以帮你?" }
  ],
  "stop_reason": "end_turn",          // end_turn | max_tokens | stop_sequence | tool_use
  "stop_sequence": null,
  "usage": { "input_tokens": 12, "output_tokens": 24 }
}
```

工具调用时,`content` 含 `{ "type": "tool_use", "id": "...", "name": "get_weather", "input": {...} }`,`stop_reason: "tool_use"`。

### 5.3 流式响应(`stream: true`)

`Content-Type: text/event-stream`,按 Anthropic 事件序列推送:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","role":"assistant","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":24}}

event: message_stop
data: {"type":"message_stop"}
```

工具增量走 `input_json_delta`(`delta.partial_json` 累积拼装工具入参 JSON)。

---

## 6. OpenAI Chat Completions 协议 · `POST /v1/chat/completions`

### 6.1 请求

```http
POST /v1/chat/completions HTTP/1.1
Content-Type: application/json
Authorization: Bearer <gateway-key>
```

```jsonc
{
  "model": "...",
  "messages": [
    { "role": "system", "content": "你是助手" },
    { "role": "user", "content": "你好" }
  ],
  "temperature": 0.7,
  "top_p": 1,
  "max_tokens": 1024,
  "stream": false,
  "stop": ["\n\n"],
  "tools": [
    { "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } } }
  ],
  "tool_choice": "auto"
}
```

### 6.2 非流式响应

```jsonc
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1725400000,
  "model": "...",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "你好,有什么可以帮你?" },
      "finish_reason": "stop"          // stop | length | tool_calls
    }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 24, "total_tokens": 36 }
}
```

工具调用时 `message.tool_calls: [{ "id": "...", "type": "function", "function": { "name": "...", "arguments": "{...}" } }]`,`finish_reason: "tool_calls"`。

### 6.3 流式响应(`stream: true`)

SSE,每块 `object: "chat.completion.chunk"`,`choices[].delta` 增量,末尾以 `data: [DONE]` 收束:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你"}}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"}}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## 7. OpenAI Responses 协议 · `POST /v1/responses`

上游支持的较新 OpenAI 协议;当 provider 标注需要或开启 `useResponsesApi` 时,网关以此协议与上游通信。

### 7.1 请求

```jsonc
{
  "model": "...",
  "input": "你好",                      // 或结构化 input 数组
  "instructions": "你是助手",           // 等价 system
  "max_output_tokens": 1024,
  "temperature": 0.7,
  "stream": false,
  "tools": [
    { "type": "function", "name": "get_weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } }
  ]
}
```

`input` 数组形态:`[{ "role": "user", "content": [{ "type": "input_text", "text": "你好" }] }]`。

### 7.2 非流式响应

```jsonc
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1725400000,
  "model": "...",
  "status": "completed",               // completed | incomplete | failed
  "output": [
    {
      "id": "msg_...",
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "你好,有什么可以帮你?" }]
    }
  ],
  "usage": { "input_tokens": 12, "output_tokens": 24, "total_tokens": 36 }
}
```

工具调用为 `output` 中 `{ "type": "function_call", "name": "...", "arguments": "{...}", "call_id": "..." }`。

### 7.3 流式响应(`stream: true`)

SSE,按 Responses 语义事件推送:

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_...","status":"in_progress"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"你"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"好"}

event: response.completed
data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":24}}}
```

---

## 8. 上游归一化

网关按目标 provider 的协议约定,拼接上游 URL 并转换协议:

| 上游协议 | URL 拼接规则 |
|----------|-------------|
| Anthropic 兼容 | `<baseURL>/v1/messages`(已带 `/v1` 则补 `/messages`) |
| OpenAI Chat | `<baseURL>/v1/chat/completions`(已带 `/v1` 则补 `/chat/completions`) |
| OpenAI Responses | `<baseURL>/v1/responses`(已带 `/v1` 则补 `/responses`) |
| 模型列表(通用) | `<baseURL>/v1/models` |
| DashScope/Qwen 兼容模式 | `<baseURL>/compatible-mode/v1/models` |

**协议交叉转换**:入站协议与上游协议可以不同(例如调用方用 Anthropic `/v1/messages`,上游是 OpenAI Chat)。网关负责:

- 消息结构互转(`system` ↔ `instructions` / system message;content block ↔ 纯文本/多模态)
- 工具定义互转(`input_schema` ↔ `function.parameters`;`tool_use` ↔ `tool_calls` ↔ `function_call`)
- 停止原因映射(`end_turn`↔`stop`、`max_tokens`↔`length`、`tool_use`↔`tool_calls`)
- 流式事件互转(Anthropic 事件流 ↔ OpenAI chunk `[DONE]` ↔ Responses 语义事件)
- 用量字段映射(`input_tokens`/`output_tokens` ↔ `prompt_tokens`/`completion_tokens`)

---

## 9. 健康检查与故障切换(Failover)

网关为每个 provider 维护健康状态,支持失败自动切换到备选 provider:

- **健康评分**:统计成功/失败、错误码、延迟,标记 provider 健康度。
- **自动切换**(`failoverAutoSwitch`):当前 provider 连续失败时,按优先级切换到下一个可用 provider 并重试;切换事件回传前端提示 `{{from}} failed, switching to {{to}}`。
- **恢复**:失败 provider 冷却后重新纳入候选;可手动 `resetHealth` 重置。

---

## 10. IPC 控制通道(渲染 ↔ 主)

网关运行在主进程,前端通过 IPC 控制与观测(命名沿用内部代号,不涉及具体推理引擎):

| 频道 | 类型 | 说明 |
|------|------|------|
| `modelGateway:getStatus` | invoke | 获取网关运行状态(端口、请求数、错误) |
| `modelGateway:sync` | invoke | 同步/重载 provider 与模型配置 |
| `modelGateway:statusChanged` | event | 网关状态变更推送 |
| `claudeProxy:getStatus` / `getHealth` | invoke | 代理与各 provider 健康快照 |
| `claudeProxy:resetHealth` / `resetAllHealth` | invoke | 重置健康状态 |
| `claudeProxy:statusChanged` | event | 代理状态变更 |
| `claudeProxy:providerSwitched` | event | provider 故障切换通知 |
| `claudeProxy:failover` | event | 失败切换事件流 |
| `claudeProxy:error` | event | 代理错误 |
| `provider:listModels` | invoke | 拉取某 provider 模型列表 |
| `provider:test` / `testImage` | invoke | 连通性 / 图像能力测试 |
| `provider:scanCapabilities` / `probeReasoning` | invoke | 能力扫描 / 推理能力探测 |
| `provider:getBalance` | invoke | 余额查询 |
| `provider:getCredentialPreference` | invoke | 凭证偏好 |

---

## 11. 速查

| 项 | 值 |
|----|----|
| 地址 | `http://127.0.0.1:19836`(默认端口,动态可变) |
| 入站端点 | `POST /v1/messages`、`POST /v1/chat/completions`、`GET /v1/models`、`GET /health` |
| 上游协议 | Anthropic Messages / OpenAI Chat Completions / OpenAI Responses |
| 鉴权 | `x-api-key`+`anthropic-version` 或 `Authorization: Bearer` |
| 流式 | SSE `text/event-stream`;Anthropic 事件 / OpenAI `[DONE]` / Responses 事件 |
| 能力 | 多 provider 协议归一化 + 健康检查 + 故障自动切换 |
| 控制 | `modelGateway:*` / `claudeProxy:*` / `provider:*` IPC 通道 |
