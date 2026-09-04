# 07 · 安全桥 `src/preload`

> 78 行的 `index.ts` + 14 行的 `index.d.ts`。定位是**安全边界，不是转发层**（`index.ts:1-15`）。

## 1. 暴露面：三个通用原语 + 一个元信息对象

```ts
contextBridge.exposeInMainWorld('nextcowork', api)   // index.ts:74
```

> ⚠️ 命名空间是 **`window.nextcowork`**，不是既有协议文档里的 `window.newmax` —— `newmax` 在源码中零命中。

| 成员 | 签名 | 行 | 底层原语 |
|---|---|---|---|
| `invoke` | `<K extends InvokeChannel>(ch, req) => Promise<IpcResult<InvokeRes<K>>>` | :37-42 | `ipcRenderer.invoke` |
| `send` | `<K extends SendChannel>(ch, payload) => void` | :45-48 | `ipcRenderer.send` |
| `on` | `<K extends EventChannel>(ch, cb) => Unsubscribe` | :54-62 | `ipcRenderer.on` / `removeListener` |
| `versions` | `{electron, chrome, node}` | :64-68 | `process.versions` |

频道的类型全部来自 `shared/ipc/contract.ts` 的三张表（62 条：invoke 47 + send 5 + event 10，按模块分布见 [02 篇 §2](./02-shared-contract.md)）。preload **不做每频道封装** —— 频道字符串由渲染层 services 层传入。

### 失败语义（三种刻意不一致）

| 情形 | 行为 |
|---|---|
| invoke 未登记频道 | `Promise.reject(new Error('[preload] 未登记的 invoke 频道: …'))` —— **整个 preload 唯一会 reject 的路径**（可被上层 catch） |
| send / on 未登记频道 | 同步 `throw`（它们没有回程信封可报错） |
| 主进程 handler 抛异常 | 永远不会 —— `safeHandle` 兜成 `IpcResult`（成功路径永远 resolve） |

## 2. 四道防线

1. **运行时频道白名单**（`:38/46/55`）：每次分发前调 `isInvokeChannel/isSendChannel/isEventChannel`（`Object.prototype.hasOwnProperty.call`，防原型链击穿）。★ 动机（`:4-7`）：「仅有编译期类型不够 —— 被攻破的渲染层可以 `invoke(任意字符串)`，而在本架构里那等价于经工具层获得任意文件系统访问。」白名单与三张 Map 的双向绑定由 `satisfies Record<keyof XxxMap, 1>` 在编译期强制（少一条/多一条都编译不过）。
2. **绝不把 `IpcRendererEvent` 交给渲染层**（`:56-57`）：只把 payload 回调出去 —— 事件对象带 `sender`，是现成的逃逸口。
3. **`on` 无条件返回退订函数**（`:59-61`）：协议 §3.3 硬约定；否则 HMR 会叠几十个监听器。
4. **contextIsolation 兜底断言**（`:73-78`）：`process.contextIsolated === false` 直接 throw —— 「宁可白屏，也不要静默降级成一个没有边界的桥」（失败方向朝安全倒）。

## 3. 单文件打包的因果链

```
sandbox: true (main/index.ts:62)
  └─ 沙箱化 preload 无法 require 多文件模块
       └─ electron.vite.config.ts: isolatedEntries: true + externalizeDeps: false
            └─ preload 只 import 类型 + 三个纯函数守卫（背后是可内联的 const 白名单表），
               不 import 任何 node 内置模块
                 └─ 产物 out/preload/index.js 单文件 ~3.4KB，仅 1 处 require('electron')
```

## 4. 渲染层被限制的方式（纵深）

1. 无 Node：`nodeIntegration:false` + sandbox，渲染层拿不到 `fs`/`child_process`/`ipcRenderer` 本体。
2. 桥只透出 payload（防线 2）。
3. 任意路径不经渲染层：`workspace:pick` 走主进程 dialog；`workspace:listDir` 的 path 是工作区相对路径且过 `resolveInWorkspace`。
4. 密钥只写不读：`provider:setCredential` 返回 `{hasKey,last4}`；`credentialRef` 是 safeStorage 引用；内核里明文只存在于 `KernelHost.secrets.get()` 之后。
5. 导航与弹窗封锁：`setWindowOpenHandler` / `will-navigate`（[06 篇 §1](./06-main-process.md)）。
6. CSP：`index.html` 内联**严格 CSP**；dev 下由 `cspDevPlugin()` **整段替换**成放宽版 —— 「故意做成替换而不是注入：插件哪天没生效，留在页面里的就是严格版，失败方向朝安全那边倒」。
7. 打包层：electron fuses 关闭 `runAsNode` / `enableNodeOptionsEnvironmentVariable` / `enableNodeCliInspectArguments`（收掉三条把进程当 Node 跑的逃逸口）；`enableCookieEncryption:true`。
8. 渲染层自己的兜底：`services/ipc.ts` 的 `bridge()` 在 `window.nextcowork` 不存在时**立刻大声 throw**，而不是让每个调用点收到 undefined。

## 5. `index.d.ts` —— 类型链

```ts
import type { NextCoWorkApi } from './index'          // NextCoWorkApi = typeof api
declare global { interface Window { nextcowork: NextCoWorkApi } }
```

类型从**实现对象**推导（`NextCoWorkApi = typeof api`，`index.ts:71`），`api` 每个方法的签名又由 contract 的 `InvokeReq<K>/InvokeRes<K>/IpcEventMap[K]/IpcSendMap[K]` 推出 —— **手写漂移在这条链上没有位置**。跨到渲染层的唯一机制是 `tsconfig.web.json:7` 的 `"src/preload/*.d.ts"` include：「删掉那条 include，渲染层就会退化成 any，而且不报错 —— 所以两边是绑在一起的」。实现本体 `index.ts` 则归 `tsconfig.node.json`（要 import electron）。

同模式的编译期哨兵还有两处：三张白名单表、`AppSettings` 的 `PATCHABLE_KEYS`。

## 6. preload/index.d.ts 全文结构

- `NextCoWorkApi` 类型出口（供渲染层与测试引用）
- `Window` 全局扩展
- 无任何运行时代码
