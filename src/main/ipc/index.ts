/**
 * IPC 路由 —— 契约的主进程一侧。
 *
 * 两条编译期保证:
 * 1. `handlers: HandlerMap` 是**完备映射**。往 IpcInvokeMap 加一个频道却忘了写 handler,
 *    `npm run typecheck` 当场拦下 —— 而不是等到运行时收到一句
 *    「No handler registered for 'x'」。
 * 2. handler 的入参/返回类型直接由频道推出,不需要在两侧各写一遍。
 *
 * 一条运行期保证:**异常绝不穿过 ipcMain.handle**(方案 §3 规则 3)。
 */
import { ipcMain } from 'electron'
import type {
  InvokeChannel,
  InvokeReq,
  InvokeRes,
  IpcResult,
  IpcSendMap,
  SendChannel
} from '../../shared/ipc/contract'
import { INVOKE_CHANNELS, SEND_CHANNELS } from '../../shared/ipc/contract'
import { EMPTY_INNER, EMPTY_OUTER, innerTabKey, outerTabKey, store } from '../state/store'
import { windows, type WindowContext } from '../window/registry'
import { getBootstrap, openExternal, registerThemeBridge } from './app'
import { abortRun, attachRun, startRun } from './agent'
import { NotImplementedError, toAgentError } from './errors'
import { listModels, listProviders } from './provider'
import { getSettings, updateSettings } from './settings'
import { closeWorkspace, listDir, listWorkspaces, pickWorkspace, updateWorkspace } from './workspace'

type Handler<K extends InvokeChannel> = (
  req: InvokeReq<K>,
  ctx: WindowContext
) => InvokeRes<K> | Promise<InvokeRes<K>>

type HandlerMap = { [K in InvokeChannel]: Handler<K> }

type SendHandler<K extends SendChannel> = (payload: IpcSendMap[K], ctx: WindowContext) => void

type SendHandlerMap = { [K in SendChannel]: SendHandler<K> }

/**
 * 契约里已登记、但对应子系统还没到实施顺序那一步的频道。
 * 刻意**不留空**:每一个都指名道姓写出它属于哪一步,
 * 这样「契约完整 / 实现进度」两件事在同一个文件里就能对上。
 */
function todo<K extends InvokeChannel>(channel: K, step: string): Handler<K> {
  return () => {
    throw new NotImplementedError(channel, step)
  }
}

// ═══════════════════════════════════════════════════════════════
// invoke
// ═══════════════════════════════════════════════════════════════

const handlers: HandlerMap = {
  // ── 已实现 ──
  'app:getBootstrap': (_req, ctx) => getBootstrap(ctx.kind),
  'app:openExternal': ({ url }) => openExternal(url),
  'settings:get': () => getSettings(),
  'settings:update': (patch) => updateSettings(patch),
  'workspace:list': () => listWorkspaces(),
  'workspace:pick': () => pickWorkspace(),
  'workspace:update': (req) => updateWorkspace(req),
  'workspace:close': ({ id }) => closeWorkspace(id),
  'workspace:listDir': (req) => listDir(req),
  'tabs:getInner': ({ workspaceId }) => store.getKv(innerTabKey(workspaceId), EMPTY_INNER),

  // ── 步骤 6:SQLite ──
  'sessions:list': todo('sessions:list', '步骤 6'),
  'sessions:get': todo('sessions:get', '步骤 6'),
  'sessions:create': todo('sessions:create', '步骤 6'),
  'sessions:rename': todo('sessions:rename', '步骤 6'),
  'sessions:setArchived': todo('sessions:setArchived', '步骤 6'),
  'sessions:setFavorited': todo('sessions:setFavorited', '步骤 6'),
  'sessions:delete': todo('sessions:delete', '步骤 6'),
  'conversations:searchAll': todo('conversations:searchAll', '步骤 6(FTS5)'),
  'storage:getStats': todo('storage:getStats', '步骤 6'),
  'storage:vacuum': todo('storage:vacuum', '步骤 6'),

  // ── 步骤 3–5:RunRegistry / AgentSession / 交互 ──
  'agent:run': (req, ctx) => startRun(req, ctx),
  'agent:attach': (req, ctx) => attachRun(req, ctx),
  'agent:abort': (req) => abortRun(req),
  'agent:respondInteraction': todo('agent:respondInteraction', '步骤 5'),
  'agent:listInteractions': todo('agent:listInteractions', '步骤 5'),
  'agent:listTools': todo('agent:listTools', '步骤 4'),

  // ── 步骤 8:终端 ──
  'terminal:create': todo('terminal:create', '步骤 8'),
  'terminal:kill': todo('terminal:kill', '步骤 8'),
  'terminal:list': todo('terminal:list', '步骤 8'),
  'terminal:getBuffer': todo('terminal:getBuffer', '步骤 8'),

  // ── 步骤 10:MCP ──
  'mcp:list': todo('mcp:list', '步骤 10'),
  'mcp:upsert': todo('mcp:upsert', '步骤 10'),
  'mcp:remove': todo('mcp:remove', '步骤 10'),
  'mcp:testConnection': todo('mcp:testConnection', '步骤 10'),

  // ── 步骤 12:Skill ──
  'skills:list': todo('skills:list', '步骤 12'),
  'skills:setGlobalEnabled': todo('skills:setGlobalEnabled', '步骤 12'),
  'skills:setWorkspaceActive': todo('skills:setWorkspaceActive', '步骤 12'),

  // ── 步骤 4 / 13:上游与网关 ──
  // 只读两条已实现:它们是输入框那颗模型选择器的唯一数据源(见 ipc/provider.ts)
  'provider:list': () => listProviders(),
  'provider:listModels': ({ providerId }) => listModels(providerId),
  'provider:upsert': todo('provider:upsert', '步骤 4'),
  'provider:remove': todo('provider:remove', '步骤 4'),
  'provider:setCredential': todo('provider:setCredential', '步骤 4(safeStorage)'),
  'provider:getCredentialInfo': todo('provider:getCredentialInfo', '步骤 4'),
  'provider:test': todo('provider:test', '步骤 4'),
  'gateway:getStatus': todo('gateway:getStatus', '步骤 13'),
  'gateway:setEnabled': todo('gateway:setEnabled', '步骤 13'),
  'gateway:resetHealth': todo('gateway:resetHealth', '步骤 13')
}

// ═══════════════════════════════════════════════════════════════
// send —— 高频无返回(协议 §3.2)
// ═══════════════════════════════════════════════════════════════

/**
 * Tab 布局落盘防抖 500ms(方案 §9):拖动排序时每帧都在变,
 * 切个 Tab 不能同步命中磁盘。
 */
const PERSIST_DEBOUNCE_MS = 500
const pendingPersists = new Map<string, { timer: NodeJS.Timeout; value: unknown }>()

function persistDebounced(key: string, value: unknown): void {
  const prev = pendingPersists.get(key)
  if (prev) clearTimeout(prev.timer)
  const timer = setTimeout(() => {
    pendingPersists.delete(key)
    store.setKv(key, value)
  }, PERSIST_DEBOUNCE_MS)
  // 连值一起存住:退出时要**写掉**它,不是丢掉它
  pendingPersists.set(key, { timer, value })
}

/** app quit 前把挂着的写入落掉,否则最后一次拖动的顺序会丢。 */
export function flushPendingPersists(): void {
  for (const [key, { timer, value }] of pendingPersists) {
    clearTimeout(timer)
    store.setKv(key, value)
  }
  pendingPersists.clear()
}

const sendHandlers: SendHandlerMap = {
  'window:ready': ({ kind }, ctx) => {
    windows.markReady(ctx.sender, kind)
    // 握手第一条腿(协议 §7)。一行日志,但它是「渲染层真的跑起来了」
    // 在主进程侧唯一的可观测证据 —— 渲染层的 console 不进这个 stdout。
    console.log(`[ipc] 窗口就绪 · kind=${kind}`)
  },
  'tabs:persistOuter': ({ kind, state }) => persistDebounced(outerTabKey(kind), state),
  'tabs:persistInner': ({ workspaceId, state }) =>
    persistDebounced(innerTabKey(workspaceId), state),

  // 步骤 8 接上 TerminalHost
  'terminal:write': () => {},
  'terminal:resize': () => {}
}

// ═══════════════════════════════════════════════════════════════
// 注册
// ═══════════════════════════════════════════════════════════════

/**
 * ★ 异常绝不穿过 ipcMain.handle。Electron 会把它 stringify 成
 * `Error: Error invoking remote method 'x': ...`,§4.11 那套 code 分类全丢,
 * UI 就没法决定「跳设置页 / 提示 compact / 显示重试倒计时」。
 */
function safeHandle<K extends InvokeChannel>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (event, req): Promise<IpcResult<InvokeRes<K>>> => {
    try {
      const data = await fn(req as InvokeReq<K>, windows.of(event.sender))
      return { ok: true, data }
    } catch (err) {
      const error = toAgentError(err)
      // 未实现的频道也是 code:'unknown'(UI 侧「弹个 toast」的处理是对的),
      // 但它不是故障,不该打堆栈 —— 后面还有十几步没实现,
      // 每步都往控制台糊一屏堆栈的话,真正的错误就沉底了。
      if (err instanceof NotImplementedError) console.warn(`[ipc] ${error.message}`)
      else if (error.code === 'unknown') console.error(`[ipc] ${channel} 失败:`, err)
      return { ok: false, error }
    }
  })
}

export function registerIpc(): void {
  for (const channel of Object.keys(INVOKE_CHANNELS) as InvokeChannel[]) {
    safeHandle(channel, handlers[channel] as Handler<InvokeChannel>)
  }

  for (const channel of Object.keys(SEND_CHANNELS) as SendChannel[]) {
    ipcMain.on(channel, (event, payload) => {
      // send 没有回程信封可以报错。**必须**兜住异常,
      // 否则一个畸形载荷就是主进程里的 uncaught exception。
      try {
        const fn = sendHandlers[channel] as SendHandler<SendChannel>
        fn(payload, windows.of(event.sender))
      } catch (err) {
        console.error(`[ipc] send ${channel} 失败:`, err)
      }
    })
  }

  registerThemeBridge()
}

export { EMPTY_OUTER }
export { shutdownRuns } from './agent'
