# 复刻 ZCode 浏览器自动化能力（四期全量）

# 背景

ZCode 的浏览器能力 = 三层输入精度（语义 ref → dom_cua 节点 → cua 坐标）+ ARIA 快照作为定位器唯一事实源 + IAB/无头 CDP 双后端 + 模拟光标可视化。NextCoWork 现状：`browser_snapshot` 是 HTTP fetch + 正则洗文本（`src/main/kernel/tool/builtin/browser.ts:38`），与 UI 里的 `<webview>` 完全脱节；无任何输入派发能力。

已确认的决策（用户拍板）：
- **四期一次做完**：绑定桥 + ARIA 真快照 + 完整交互工具组 + 模拟光标 overlay + 用户标签认领。
- **输入派发走 CDP debugger**（`webContents.debugger` + `Input.dispatchMouseEvent`，ZCode 同款），不用 `sendInputEvent`。
- **fetch 版快照直接删除**，`browser_snapshot` 一律改为 webview AX 树；不保留 `browser_read` 降级。
- **无头 CDP 后端一起做**：引入 `playwright-core` 管理外部 Chromium。

# 架构总览

```
Agent 工具 (kernel/tool/builtin/browser.ts)
        │ 仅引用 browserManager（纯数据）+ browserRuntime（副作用）
        ▼
src/main/browser/
  manager.ts      纯数据状态（不变，微扩）
  bindings.ts     新增：BrowserTab.id → 后端页面句柄 的绑定表（唯一持有 Electron/Playwright 引用的模块）
  cdp-session.ts  新增：CDP debugger 会话封装（attach/命令/超时/错误归一）
  aria-snapshot.ts 新增：页面内注入脚本产物 → 紧凑 ARIA 树文本（纯函数，可测）
  input.ts        新增：click/type/press/scroll/drag 的 CDP 输入派发
  headless.ts     新增：playwright-core 无头后端（浏览器二进制解析 + 生命周期）
  session.ts      不动（cookie 导入导出）
```

两个后端实现同一个接口：

```ts
// bindings.ts
export interface PageHandle {
  backend: 'iab' | 'headless'
  /** ARIA 快照（注入脚本）→ { tree: string, refs: PageRefTable } */
  snapshot(): Promise<SnapshotResult>
  /** ref 或坐标输入；coords 为 CSS 像素视口坐标 */
  dispatch(input: CuaInput): Promise<void>
  insertText(text: string): Promise<void>
  evaluate<T>(expr: string): Promise<T>
  screenshot(): Promise<Uint8Array>
  url(): string
  title(): string
  goto(url: string): Promise<void>
  close(): Promise<void>
  onGone(cb: () => void): void
}
```

- **iab 后端**：`webContents.debugger.attach('1.3')` + `Runtime.evaluate` 注入快照脚本 + `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`。快照脚本在页面里维护 `window.__ncw_refs: Map<string, Element>`，导航即失效（天然的 staleness 语义，对齐 ZCode 的 `state_id` 消费机制）。
- **headless 后端**：playwright-core `chromium.launch()`，同样的快照脚本经 `page.evaluate` 注入，输入走 `page.mouse`/`page.keyboard`（Playwright 内部就是 CDP Input）。

依赖方向红线：`kernel/**` 继续零 electron import——工具层只 import `manager.ts`（纯数据）与 `bindings.ts` 暴露的**接口函数**；bindings 在 Electron 缺席（无头测试）时返回明确的 `unavailable` 错误。参照 `host.browserFetch` 的既有模式。

# 分步实施

## Phase 1 — webContents 绑定桥

### 1.1 绑定的建立（渲染层显式上报，主进程校验）

`<webview>` 有 `getWebContentsId()`（Electron 44 支持）与 `did-attach` 事件。绑定流程：

1. `BrowserView.tsx` 在 webview `did-attach` 后调 `services/browser.ts` 新函数 `bindBrowserView(workspaceId, browserId, webContentsId)` → IPC `browser:bind`。
2. 主进程 `bindings.ts` 校验后接受绑定：
   - `webContents.fromId(webContentsId).getType() === 'webview'`
   - 其 session partition 等于 `browserPartition(workspaceId, tab.profileId)`（防伪造上报，对齐 `index.ts:234` 的 will-attach 防线）
   - `browserManager.get(browserId)` 存在且 workspaceId 匹配
3. 绑定表项：`{ tabId, webContentsId, attachedAt }`。webview `destroyed` / webContents `render-process-gone` 且不可恢复 / tab close 时清项。
4. **重复挂载**（HMR、标签切回、多窗口同一 browserId）：后绑定覆盖旧项；旧 webContents 若已 destroyed 则自然失效。同一 tabId 同时只允许一个活跃绑定。

### 1.2 无头后端的绑定

headless 页面无 webContents，`bindings.ts` 内直接以 Playwright `Page` 对象为句柄注册进同一张表，tabId 命名空间一致。

### 1.3 BrowserTab 数据扩展（`shared/domain/browser.ts`）

```ts
export type BrowserTabBackend = 'iab' | 'headless'
interface BrowserTab {
  // ...现有字段
  backend: BrowserTabBackend        // 新增，默认 'iab'
  viewport?: { width: number; height: number }
}
```

`browserManager.open` 增加 `backend` 入参（agent 工具选择后端用）。

## Phase 2 — ARIA 快照替换 fetch 版

### 2.1 快照脚本（页面内执行，两后端共用）

存为字符串常量放 `src/main/browser/snapshot-script.ts`（**不打包进 renderer**）。行为：

1. 遍历可见元素（近似 Playwright ariaSnapshot 逻辑：语义节点 = 有 role/可交互/可见文本），输出紧凑树：
   `- button "Sign in" [ref=e5]`
   `- textbox "Search" [ref=e8] [value=hello]`
   `- heading "Products" [level=2] [ref=e12]`
2. 为每个语义节点分配 `eN` 序号，存 `window.__ncw_refs` Map（ref → element）+ 缓存该元素 getBoundingClientRect 中心点。
3. 返回 `{ tree: string, pageUrl, stamp }`。`stamp` 是导航计数（`performance.navigation`/history patch），用于失效判定。
4. 预算：树文本截断在 80k 字符（沿用现 `MAX_SNAPSHOT_CHARS`）；iframe 不展开第一版（`allowpopups=false` 且多数场景够用，写进工具 description 声明局限）。

### 2.2 `aria-snapshot.ts`（纯函数，测试重点）

输入脚本的原始返回，输出最终给模型的文本（拼 `Page: <title>\nURL: <url>\n\n<tree>`、截断、规范化空白）。不碰 Electron，`__tests__` 全覆盖。

### 2.3 新 `browser_snapshot` 工具

- 输入：`{ tabId: string }`（maxChars 删除——统一 80k）
- 行为：取绑定 → `PageHandle.snapshot()` → 校验 stamp 未变（页面在快照期间导航了就 fail，模型重试）→ 返回树。
- ref 解析规则写进 description：**"click/type/select 的 ref 必须来自最近一次 browser_snapshot；导航后必须重拍"**。
- **删除** `fetchPublicPage` / `readPageText` / `pageText`（约 90 行）及 `WEB_LIMITS` 引用；`browserFetch` 端口若无其他消费者则连端口一起清（查完全局引用后决定，`host.ts:157` 注释同步更新）。
- 所有会引起新网络请求的工具保留 SSRF 检查（`ssrfRisk` + `resolvedAddressRisk`）：open/navigate/goto。

### 2.4 `browser_tabs` 增强

输出补 `active`（当前 renderer 正在展示的 webview 对应绑定）、`viewport`、`backend`。仍只列本 run 自己的 tab（所有权不变）。

## Phase 3 — 交互工具组

### 3.1 CDP 输入派发 `input.ts`

- `click(ref, button?, clickCount?)`：`Runtime.evaluate` 取 `__ncw_refs[ref]` 的中心坐标（**派发前重取**，不用快照时的缓存）→ 逐个 `Input.dispatchMouseEvent`（mouseMoved → mousePressed → mouseReleased）。
- `type(ref, text)`：click 定位 → focus（click 或 `DOM.focus`）→ `Input.insertText`（中文/IME 安全）。
- `press(ref?, keys)`：组合键走 `Input.dispatchKeyEvent`（rawKeyDown/char/keyUp 序列），keys 视为一个组合（ZCode 语义）。
- `selectOption(ref, values)`：直接 `element.value=...` + dispatch change 事件（CDP `DOM.setAttributeValue` 不适用 select，走 evaluate 最稳）。
- `scroll(x?, y?, scrollX, scrollY)`：`Input.dispatchMouseEvent({ type: 'mouseWheel' })`。
- `cuaClick(x, y, button?)` / `cuaDrag(path: {x,y}[], modifiers?)`：纯坐标，逐点 `mouseMoved`（ZCode：**保留每一个点**，轨迹自然）。
- 全部操作前发 stamp 校验；ref 查不到 → fail 并提示重拍快照（对齐"count===0 就重拍"纪律）。
- 等待：动作后可观察状态由模型用 snapshot 验证；工具内不做固定 sleep。

### 3.2 工具注册（全部加进 `browserTools` 数组）

| 工具 | readOnly | destructive | notes |
|---|---|---|---|
| browser_click | false | false | ref 定位 |
| browser_type | false | false | |
| browser_press | false | false | |
| browser_select | false | false | |
| browser_scroll | true | false | 纯滚动 |
| browser_screenshot | true | false | 见 3.3 |
| browser_cua_click | false | false | 坐标 |
| browser_cua_drag | false | false | 坐标路径 |

权限语义：readOnly=false 走 §4.5 表的 ask/auto 档（plan 模式不下发，`permission-gate.ts:45` 已有）；不标 destructive（页面内动作在权限模式下已过审批）。

**工具 description 写入 ZCode 纪律**（这是能力的一半）：一次观察周期一个状态变更动作；locator/ref 必须来自最新快照；失败/超时不许原样重试，先重拍；判断动作成功看预期效果出现，不看 tabs.list 非空。

### 3.3 browser_screenshot

- iab：`webContents.capturePage()` → PNG；headless：`page.screenshot()`。
- 返回走 `toolOk(content, { blocks: [{ type: 'image', dataRef: 'data:image/png;base64,…' }] })`——`shared/agent/tool-card.ts:37` 已支持 image block 且有独立字节预算；超预算时缩放（capturePage 后用原生 `nativeImage.resize`，最大边 1600）。
- description 注明"仅当快照缺目标（canvas/自绘）或用户要求视觉验证时使用"。

### 3.4 用户标签认领

- `browser_user_tabs`（readOnly）：列出本工作区 `source === 'user'` 的 tab（id/title/url），无控制权。
- `browser_claim`（readOnly=false）：`manager.claim(id, actor)` —— 若 tab 尚无 ownerRunId 则盖上 `ctx.runId`；已有 owner 且非自己 → fail。认领后即可被全部交互工具操作（`requireOwned` 已天然支持）。
- `BrowserManager.claim` 是 manager.ts 唯一的行为新增（约 15 行）。

### 3.5 无头后端 `headless.ts`（playwright-core）

- 依赖：`package.json` 加 `playwright-core`（仅 main 用，devDependencies 不动 renderer）。
- 浏览器二进制解析顺序：① `userData/browsers/` 下已下载的 chromium（首次使用时经 permission-gate ask 批准后调 `chromium.launch({ executablePath })` 下载——needsNetwork=true 已覆盖出网审批）② 系统 Chrome/Edge channel。
- 生命周期：单例 Browser，进程退出时 `browser.close()`（挂 `app.on('will-quit')`）。页面崩溃/关闭 → 绑定失效。
- `browser_open` 增加 `backend?: 'headless'` 入参；未拿到二进制时 fail 并给出人话指引（不静默降级到 iab，ZCode 语义）。
- 工具 `isEnabled`：无头后端仅在本地工作区可用（复用 `assertLocalBrowserWorkspace`）。

## Phase 4 — 模拟光标 overlay 与体验层

### 4.1 光标事件流

- `input.ts` 每次派发坐标事件时，经 `setBrowserChangeListener` 同款通道 emit 新事件 `browser:cua`（`contract.ts` 事件区登记）：
  `{ workspaceId, tabId, kind: 'move' | 'click' | 'type', x, y, at }`。
- 仅 iab 后端发（headless 无可视面）。

### 4.2 renderer overlay

- `BrowserView.tsx`：webview 容器内叠一层 `pointer-events-none` 的绝对定位层，订阅 `browser:cua`（`services/browser.ts` 加 `onBrowserCua`，`on()` 返回值进 `useEffect` cleanup——§1 硬规则）。
- 表现：光标图标（lucide `MousePointer2`）+ 200ms 淡出；click 时涟漪一帧；type 时键盘指示。仅当该 webview 对应的 browserId 匹配才显示。
- `aria-hidden="true"`，无文案，不需要 i18n。

### 4.3 i18n

新用户可见文案（错误提示、设置/认领相关）：按 §6 硬规则进 `i18n/`。工具侧给模型的字符串（toolFail 内容）不是 UI 文案，保持英文（与现有 browser.ts 一致）。

# 涉及文件清单

**主进程**
- 新增 `src/main/browser/bindings.ts`、`cdp-session.ts`、`input.ts`、`aria-snapshot.ts`、`snapshot-script.ts`、`headless.ts`
- 改 `src/main/browser/manager.ts`（+backend/viewport/claim，约 40 行）
- 重写 `src/main/kernel/tool/builtin/browser.ts`（删 fetch 链路，加 9 个工具）
- 改 `src/main/index.ts`（did-attach-webview 处挂 destroyed 清理；will-quit 关 headless）
- 改 `src/main/ipc/`（browser:bind / browser:cua 事件注册）

**shared**
- `shared/domain/browser.ts`（+backend/viewport 字段）
- `shared/ipc/contract.ts`（browser:bind 请求、browser:cua 事件）

**渲染层**
- `services/browser.ts`（+bindBrowserView/onBrowserCua）
- `views/browser/BrowserView.tsx`（did-attach 上报 + overlay）

**依赖**
- `package.json` + `playwright-core`

# 测试计划（vitest，`.test.ts` only）

- `aria-snapshot.test.ts`：树压缩/截断/规范化的纯函数全分支（重点）。
- `manager.test.ts` 扩：claim 的三种结局（无主→盖上 / 自己→幂等 / 他人→拒）；backend 字段。
- `bindings.test.ts`：接口层用假 PageHandle（不 import electron），测绑定生命周期/覆盖/失效与所有权拒绝。
- `input.test.ts`：ref 缺失、stamp 过期、坐标越界的失败路径（CDP 命令序列打桩）。
- 工具层测试沿用 `builtin/__tests__/browser.test.ts` 模式：假 host + 假绑定表，验证所有权、SSRF、错误文案。

# 边界与风险

1. **webview getWebContentsId 时序**：did-attach 后才有值；renderer 上报失败（窗口关闭竞态）要幂等——主进程接受"绑定一个已 destroyed 的 webContents"时静默拒绝即可，渲染层不重试风暴。
2. **debugger 冲突**：一个 webContents 只能 attach 一个 debugger。devtools 打开时（用户 F12）attach 会失败——`cdp-session.ts` 对 "Another debugger is already attached" 返回专用错误文案，提示关闭 devtools。
3. **devicePixelRatio**：`getBoundingClientRect` 是 CSS 像素，`Input.dispatchMouseEvent` 同坐标系，无需换算；但 `capturePage` 出图是物理像素——overlay 定位与截图标注时注意。
4. **sandbox 页面注入**：webview 是 sandbox=yes + 无 preload（`index.ts:235`），`Runtime.evaluate` 注入不受影响（CDP 层，不走 preload）。
5. **页面 SPA 导航检测**：stamp 用 history patch + navigation entry 双保险；无法检测的 corner（pushState 不触发任何事件）由"重拍快照纪律"兜底。
6. **playwright-core 体积**：包本身 ~8MB 进 asar；浏览器二进制不打包、首次用下载到 userData。electron-builder 配置无需改（不进 asar.unpacked）。
7. **旧 fetch 快照删除的兼容**：已有会话转录里的工具调用描述会变——无迁移问题（转录只是记录），但 `builtin/__tests__/browser.test.ts` 现有 fetch 相关断言全部重写。

# 验证

```bash
npm run typecheck:web   # 渲染层 + shared
npm run typecheck       # 主进程（含 playwright-core 类型）
npm test                # vitest 全量
npm run lint
```

手工冒烟（dev 模式）：
1. 让 Agent 开页面 → browser_snapshot 返回 ARIA 树 → browser_click 一个 ref → overlay 出现光标 → 页面响应。
2. 在 canvas 页面用 browser_cua_click 坐标点击。
3. 打开两个 tab 验证所有权：run A 不能操作 run B 的 tab。
4. headless：browser_open backend=headless → 无窗口完成 navigate+snapshot+click。
5. F12 打开 devtools 后工具应返回专用错误；关闭后恢复。

# 明确不做（本轮砍掉）

- WebM 录屏（ZCode 有；Electron 无 capturePage 视频流，成本高，另立项）。
- OS 级 computer-use（辅助功能树 + 真实鼠标，独立产品线）。
- `extension` 后端（浏览器扩展桥接）。
- iframe 递归快照（第一版声明局限）。
