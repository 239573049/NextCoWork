# 主进程 ↔ 渲染进程 交互协议

> 本文档描述基于 Electron 的桌面应用中，**主进程(Main / Node 侧)** 与 **渲染进程(Renderer / React UI 侧)** 之间的 IPC 交互协议：进程模型、安全边界、通信原语、消息与错误约定、事件流约定，以及按业务模块划分的频道目录。
>
> 说明：本文仅覆盖通用 IPC 协议与平台能力频道，不包含底层 AI 推理引擎相关内容。

---

## 1. 架构分层

```
┌───────────────────────────────────────────────────────────────┐
│  渲染进程 (Renderer)  —— React 18 UI，运行在 Chromium 沙箱内       │
│    通过 window.newmax.* 访问受控 API（不可直接使用 Node）          │
└───────────────────────────────┬───────────────────────────────┘
                                 │  contextBridge 暴露的安全桥
┌───────────────────────────────┴───────────────────────────────┐
│  预加载脚本 (Preload)  —— 唯一的“翻译层”                          │
│    contextBridge.exposeInMainWorld("newmax", api)              │
│    把每个 API 方法映射到具体 IPC 频道（invoke / send / on）        │
└───────────────────────────────┬───────────────────────────────┘
                                 │  Electron IPC（结构化克隆序列化）
┌───────────────────────────────┴───────────────────────────────┐
│  主进程 (Main / Node)  —— 业务逻辑、原生能力、持久化               │
│    ipcMain.handle(channel, handler)   ← 请求/响应               │
│    ipcMain.on(channel, handler)       ← 单向消息                │
│    webContents.send(channel, payload) → 事件/流式推送            │
└───────────────────────────────────────────────────────────────┘
```

**职责边界**

| 层 | 能做什么 | 不能做什么 |
|----|----------|-----------|
| 渲染进程 | 渲染 UI、调用 `window.newmax.*`、订阅事件 | 直接访问文件系统 / 原生模块 / 网络凭证 |
| 预加载 | 声明 API 白名单、频道映射、参数透传 | 承载业务逻辑（保持薄） |
| 主进程 | 文件、数据库、网络、系统能力、窗口管理 | 直接操作 DOM |

---

## 2. 进程与安全模型

- **上下文隔离(context isolation)**：渲染进程与预加载运行在隔离的 JS 上下文，渲染层拿不到 Node 原生对象。
- **单一暴露入口**：所有能力通过 `contextBridge.exposeInMainWorld("newmax", api)` 注入，渲染进程只能看见 `window.newmax` 命名空间下被显式声明的方法。
- **频道白名单**：预加载不转发任意频道名；每个 API 方法内部硬编码目标频道，避免渲染进程拼接任意频道进行越权调用。
- **最小暴露面**：预加载只暴露方法签名，不暴露 `ipcRenderer` 原始对象（渲染层无法自行 `invoke` 未声明的频道）。

---

## 3. 通信原语

协议使用三种 IPC 原语，语义严格区分：

### 3.1 请求 / 响应（`invoke` ↔ `handle`）

用于**需要返回值**的调用。渲染进程发起，主进程处理并异步返回结果。这是最主要的模式（占绝大多数频道）。

```ts
// 渲染进程（经由 window.newmax）
const conv = await window.newmax.conversations.create({ title: '新会话' });

// 预加载映射
create: (payload) => ipcRenderer.invoke('conversations:create', payload)

// 主进程
ipcMain.handle('conversations:create', async (event, payload) => {
  const row = await db.createConversation(payload);
  return row;           // 作为 Promise 的 resolve 值回到渲染进程
});
```

- 返回值经**结构化克隆**序列化，须为可克隆数据（不可传函数、类实例、DOM 节点）。
- 抛出的异常会在渲染端 `await` 处 reject，见 §5 错误约定。

### 3.2 单向消息（渲染 → 主，`send` ↔ `on`）

用于**高频、无需返回值**的通知，避免请求/响应往返开销。典型如终端输入、光标事件。

```ts
// 渲染进程
window.newmax.terminal.write(id, data);

// 预加载
write: (id, data) => ipcRenderer.send('terminal:write', id, data)

// 主进程
ipcMain.on('terminal:write', (event, id, data) => pty.write(id, data));
```

### 3.3 事件订阅 / 流式推送（主 → 渲染，`webContents.send` ↔ `on`）

用于**主进程主动推送**：进度、状态变更、流式数据块。渲染进程注册回调，返回一个**取消订阅函数**用于卸载时清理。

```ts
// 预加载
onTerminalData: (cb) => {
  const listener = (_e, id, chunk) => cb(id, chunk);
  ipcRenderer.on('terminal:data', listener);
  return () => ipcRenderer.removeListener('terminal:data', listener); // 退订
}

// 主进程
pty.onData(chunk => win.webContents.send('terminal:data', id, chunk));
```

> **约定**：所有 `on*` 订阅方法都必须返回退订函数，渲染组件在 `useEffect` 清理阶段调用，防止重复监听与内存泄漏。

---

## 4. 频道命名规范

频道统一采用 **`模块:动作`** 或 **`模块:子域:动作`** 的冒号分层命名：

```
conversations:create           模块:动作
browser:window:screenshot      模块:子域:动作
hermes:workroom:members:list   模块:子域:实体:动作
```

**动作动词约定**

| 语义 | 常用动词 |
|------|----------|
| 查询单条 / 列表 | `get` / `list` / `search` |
| 写入 | `create` / `update` / `save` / `upsert` / `writeFile` |
| 删除 | `delete` / `remove` / `clear` |
| 状态切换 | `setEnabled` / `setActive` / `setFavorited` |
| 生命周期 | `start` / `stop` / `cancel` / `kill` |
| 事件（主→渲染） | `*:changed` / `*:progress` / `*:updated` / `*:data` / `*-event` |

---

## 5. 消息格式与错误约定

### 5.1 参数

- 第一个 `event` 参数由 Electron 注入，业务参数从第二个开始。
- 复杂入参统一使用**单个对象**（便于向后兼容扩展字段），如 `{ workspaceId, title, ... }`。
- 二进制内容使用 Base64 字符串通道（见 `storage:readFileBase64` / `storage:writeFileBase64`）。

### 5.2 返回值

推荐两种风格，模块内保持一致：

```ts
// 风格 A：直接返回数据，异常走 reject
return dataObject;

// 风格 B：包裹结果（用于“可预期的业务失败”不想抛异常时）
return { ok: true, data }               // 成功
return { ok: false, error: 'REASON' }   // 失败
```

### 5.3 错误传播

`handle` 中抛出的错误会被 Electron 序列化并在渲染端 `await` 处 reject：

```ts
try {
  await window.newmax.storage.readFile(path);
} catch (e) {
  // e.message 携带主进程错误信息
}
```

> 主进程应捕获底层异常并抛出**语义化错误信息**，避免把原始堆栈/敏感路径直接透传到渲染层。

---

## 6. 事件流与进度推送约定

长任务（下载、安装、录制、导出、扫描等）统一采用「**invoke 触发 + on 事件流反馈**」模式：

1. 渲染进程 `invoke` 启动任务，立即拿到一个任务句柄 / id。
2. 主进程通过 `webContents.send` 持续推送进度事件。
3. 任务结束推送终止事件（完成或失败）。
4. 渲染进程可通过独立频道 `cancel` / `stop` 中断。

**示例：技能市场安装**

```
skillMarket:install            (invoke) → 返回 taskId
skillMarket:install-progress   (on)     ← { taskId, phase, percent }
```

**类似模式的模块**

| 场景 | 触发 | 进度事件 | 取消 |
|------|------|----------|------|
| 语音模型下载 | `voiceModel:download` | `voiceModel:downloadProgress` | `voiceModel:cancelDownload` |
| 技能安装 | `skillMarket:install` | `skillMarket:install-progress` | — |
| MCP 安装 | `mcp:install` | `mcp:installProgress` | — |
| 浏览器工作流 | `browser:workflow:run` | `browser:agent:step-event` | `browser:agent:stop` |
| 内容搜索 | `storage:searchContent` | （流式结果） | `storage:searchContentAbort` |

---

## 7. 窗口与生命周期

多窗口场景下，主进程需按 `webContents` 定向推送，不能广播。

| 频道 | 方向 | 用途 |
|------|------|------|
| `appWindow:open` | 渲染→主 | 打开新窗口 |
| `appWindow:ready` | 渲染→主 | 窗口内容就绪握手 |
| `appWindow:getBootstrap` | 渲染→主 | 拉取初始化上下文（首帧数据） |
| `appWindow:updateContext` | 渲染→主 | 更新窗口业务上下文 |
| `appWindow:persistence-owner-changed` | 主→渲染 | 持久化归属权变更通知 |
| `window:resizeBy` / `window:setTrafficLightCollapsed` | 渲染→主 | 尺寸 / 交通灯按钮控制 |
| `quickWindow:show` / `quickWindow:pendingQuery` | 主→渲染 | 快捷唤起窗口 |

**握手时序**

```
渲染: appWindow:ready ──▶ 主: 记录窗口
渲染: appWindow:getBootstrap ──▶ 主: 返回 { user, workspace, settings, ... }
渲染: 首屏渲染
主:   settings:changed / auth:state-changed ──▶ 渲染: 增量更新
```

---

## 8. 模块频道目录

下表按业务模块列出主要频道（节选；`I`=invoke 请求响应，`S`=send 单向，`E`=on 事件订阅）。

### 8.1 会话与项目

| 频道 | 类型 | 说明 |
|------|------|------|
| `conversations:create` / `get` / `list` / `delete` | I | 会话增删查 |
| `conversations:getMessages` / `saveMessage` / `deleteMessages` | I | 消息读写 |
| `conversations:fork` / `clone` | I | 分叉 / 克隆会话 |
| `conversations:search` / `searchAll` | I | 会话内 / 全局搜索 |
| `conversations:setArchived` / `setFavorited` | I | 归档 / 收藏 |
| `conversations:exportTranscript` | I | 导出会话记录 |
| `conversationGroups:create` / `list` / `rename` / `reorder` | I | 会话分组 |
| `projects:create` / `get` / `list` / `update` / `delete` | I | 项目管理 |
| `projects:listMemoryFiles` / `readMemoryFile` / `writeMemoryFile` | I | 项目记忆文件 |
| `projects:updatePlanDocument` | I | 项目计划文档 |
| `projectTasks:create` / `execute` / `cancelExecution` / `getExecutionState` | I | 项目任务执行 |

### 8.2 存储与文件

| 频道 | 类型 | 说明 |
|------|------|------|
| `storage:readFile` / `writeFile` | I | 文本读写 |
| `storage:readFileBase64` / `writeFileBase64` | I | 二进制读写 |
| `storage:listDir` / `listFilesRecursive` / `statFileVersions` | I | 目录遍历 / 版本 |
| `storage:searchContent` / `searchContentAbort` / `searchFiles` | I | 内容 / 文件名搜索 |
| `storage:extractDocumentText` | I | 文档抽取纯文本 |
| `storage:undoTurnChanges` / `redoTurnChanges` / `classifyTurnChanges` | I | 变更回滚 / 重做 |
| `storage:inspectGitWorkspace` | I | Git 工作区状态 |
| `sqlite:*` | I | 本地数据库读写 |
| `export:*` | I | 数据导出 |

### 8.3 终端

| 频道 | 类型 | 说明 |
|------|------|------|
| `terminal:create` / `kill` / `list` / `exists` | I | 终端会话管理 |
| `terminal:getBuffer` | I | 拉取回滚缓冲 |
| `terminal:write` / `terminal:resize` | S | 输入 / 尺寸变更 |
| `terminal:data` / `terminal:exit` | E | 输出流 / 退出 |

### 8.4 浏览器与工作流

| 频道 | 类型 | 说明 |
|------|------|------|
| `browser:window:open` / `navigate` / `screenshot` / `close` | I | 浏览器窗口控制 |
| `browser:profile:*` | I | 浏览器配置文件管理 |
| `browser:runtime:probe-*` | I | 运行时探测（内置 / Chrome） |
| `browser:extension:status` / `restart` / `reset-pairing` | I | 配对扩展管理 |
| `browser:workflow:save` / `run` / `run-with-steps` / `history` | I | 工作流录制回放 |
| `browser:agent:step-event` | E | 步骤执行事件流 |
| `browser:window:status-changed` / `extension:status-changed` | E | 状态变更 |

### 8.5 技能与扩展

| 频道 | 类型 | 说明 |
|------|------|------|
| `skills:load` / `get` / `installFolder` / `installZip` | I | 技能加载与安装 |
| `skills:setGlobalEnabled` / `setWorkspaceActive` | I | 技能启用范围 |
| `skills:changed` | E | 技能列表变更 |
| `skillMarket:list` / `install` / `uninstall` / `installFromGit` | I | 技能市场 |
| `skillMarket:install-progress` | E | 安装进度 |
| `mcp:load` / `install` / `save` / `testConnection` | I | MCP 服务配置 |
| `mcp:config-updated` / `installProgress` | E | 配置变更 / 安装进度 |

### 8.6 语音

| 频道 | 类型 | 说明 |
|------|------|------|
| `voiceModel:download` / `cancelDownload` / `getStatus` / `delete` | I | 本地语音模型 |
| `voiceModel:transcribe` / `transcribeInterim` | I | 转写 |
| `voiceModel:downloadProgress` | E | 下载进度 |
| `voice:startRecording` / `stopRecording` / `cancelRecording` | E | 录音控制（快捷键触发） |
| `voice:transcriptionDone` | S | 转写完成 |

### 8.7 桌宠（Pet）

| 频道 | 类型 | 说明 |
|------|------|------|
| `pet:show` / `hide` / `moveBy` / `setIgnoreMouseEvents` | I | 桌宠窗口控制 |
| `pet:listPackages` / `getActivePackage` | I | 皮肤包管理 |
| `pet:task` / `clearTask` | I/E | 任务派发 |
| `pet:cursorMoved` / `keystroke` / `mainBlur` | E | 交互事件 |

### 8.8 账户、计费与权限

| 频道 | 类型 | 说明 |
|------|------|------|
| `auth:login` / `logout` / `getToken` / `getUser` | I | 认证 |
| `auth:callback` / `state-changed` | E | 回调 / 状态变更 |
| `wallet:me` / `models` / `usage` / `createOrder` / `orderStatus` | I | 钱包与订单 |
| `wallet:credentialRefreshed` | E | 凭证刷新 |
| `usage:getSummary` / `getModelStats` / `getRequestLogs` | I | 用量统计 |
| `rbac:catalog` / `providers:list` / `connection:set` | I | 权限与连接器 |
| `rbac:oauth:start` / `cloud:authorize` | I | OAuth 授权 |
| `rbac:catalog:updated` | E | 目录更新 |

### 8.9 IM 网关与协作（Hermes）

| 频道 | 类型 | 说明 |
|------|------|------|
| `im:gateway:start` / `stop` / `test` | I | IM 网关生命周期 |
| `im:config:get` / `set` | I | 平台配置 |
| `im:conversationUpdated` / `statusChanged` | E | 会话 / 状态事件 |
| `hermes:session:create` / `interrupt` | I | 协作会话 |
| `hermes:contacts:*` / `groups:*` / `messages:*` | I | 联系人 / 群 / 消息 |
| `hermes:workroom:*` | I | 工作间（成员 / 工单 / 记忆 / 确认） |
| `hermes:event` / `provision:progress` | E | 事件流 / 初始化进度 |

### 8.10 应用、窗口、设置、系统

| 频道 | 类型 | 说明 |
|------|------|------|
| `app:getPath` / `getDefaultWorkspace` / `setBadgeCount` / `setNativeTheme` | I | 应用信息与外观 |
| `app:openDataFolder` / `openLogFolder` / `openWorkspaceFolder` | I | 打开目录 |
| `app:idleStateChanged` | E | 空闲状态 |
| `settings:load` / `sync` | I | 本地设置 |
| `settingsCloud:get` / `put` / `getScoped` / `putSyncPrefs` | I | 云同步设置 |
| `settings:changed` | E | 设置变更广播 |
| `scheduledTasks:create` / `list` / `cancel` / `getExecutionState` | I | 定时任务 |
| `scheduledTasks:executionStarted` / `executionProgress` / `executionChunk` / `executionCompleted` | E | 执行事件流 |
| `computerUse:setEnabled` / `listApps` / `allowApp` / `revokeApp` | I | 系统操控授权 |
| `autoUpdate:*` | I/E | 自动更新 |
| `dialog:*` / `clipboard:*` / `notification:*` | I | 系统对话框 / 剪贴板 / 通知 |

---

## 9. 客户端封装建议

渲染层应对 `window.newmax` 再包一层类型化的 hooks / service，屏蔽频道细节：

```ts
// service 层
export const conversationService = {
  create: (input: CreateInput) => window.newmax.conversations.create(input),
  onChanged: (cb: () => void) => window.newmax.conversations.onChanged(cb),
};

// React hook 层：统一处理订阅退订
function useTerminalOutput(id: string, onData: (chunk: string) => void) {
  useEffect(() => window.newmax.terminal.onData((tid, chunk) => {
    if (tid === id) onData(chunk);
  }), [id]);   // 返回值即退订函数
}
```

**准则**

1. 组件不直接引用频道字符串，只调用 service。
2. 所有事件订阅在 `useEffect` 清理阶段退订。
3. 长任务遵循「invoke 启动 + on 进度 + cancel 中断」三段式。
4. 二进制走 Base64 频道，超大文件优先走文件路径而非内存传输。

---

## 10. 约定速查

| 约定 | 规则 |
|------|------|
| 命名 | `模块:动作`，冒号分层，小驼峰动作 |
| 请求响应 | `invoke` / `ipcMain.handle`，返回可克隆数据 |
| 单向高频 | `send` / `ipcMain.on`，无返回值 |
| 事件推送 | `webContents.send` / `on`，订阅须返回退订函数 |
| 入参 | 复杂参数用单对象，便于扩展 |
| 错误 | `handle` 抛错 → 渲染端 reject，信息需语义化脱敏 |
| 长任务 | invoke 触发 + `*:progress` 事件 + `cancel` 频道 |
| 安全 | 仅经 `contextBridge` 暴露白名单方法，不透出 `ipcRenderer` |
