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
import type { SessionInputState } from '../../shared/domain/queued-input'
import { isValidSessionInput } from '../../shared/domain/queued-input'
import {
  EMPTY_OUTER,
  innerTabKey,
  outerTabKey,
  sessionInputKey,
  store
} from '../state/store'
import { windows, type WindowContext } from '../window/registry'
import { applyTitleBarColors } from '../window/title-bar'
import { shutdownTerminals, terminalHost } from '../terminal-host'
import { copyText, getBootstrap, openExternal, openSessionWindow, registerThemeBridge } from './app'
import {
  listSessionAttachments,
  pickAttachments,
  removeAttachment,
  uploadAttachment
} from './attachment'
import { abortRun, attachRun, listInteractions, respondInteraction, startChildRun, startRun } from './agent'
import { getTools, installChildRunLauncher, setSessionChangeListener } from '../runtime'
import { NotImplementedError, toAgentError } from './errors'
import {
  fetchModels,
  getCredentialInfo,
  listModels,
  listProviders,
  removeProvider,
  setAliases,
  setCredential,
  upsertProvider,
  updateModel,
  renameModel,
  removeModel
} from './provider'
import {
  listUserModelCatalog,
  removeUserModelCatalog,
  upsertUserModelCatalog
} from './model-catalog'
import {
  getMcpSecretsInfo,
  listMcpServers,
  registerMcpBridge,
  removeMcpServer,
  setMcpSecrets,
  testMcpConnection,
  upsertMcpServer
} from './mcp'
import { getSettings, updateSettings } from './settings'
import {
  clearSearchCredential,
  listSearchProviders,
  reorderSearchProviders,
  setSearchCredential,
  setSearchEnabled,
  testSearchProvider
} from './websearch'
import { clearProxyPassword, getProxyPasswordInfo, setProxyPassword } from '../net/proxy'
import { browserManager, setBrowserChangeListener } from '../browser/manager'
import { clearBrowserProfileState, exportBrowserCookies, importBrowserCookies } from '../browser/session'
import { listSkills, setSkillGlobalEnabled, setSkillWorkspaceActive } from './skills'
import { deleteImage, importImage, listImages, migrateLegacyThemesDir, readImage, saveImage, sweepOrphans } from './theme'
import {
  closeWorkspace,
  listDir,
  listWorkspaces,
  pickWorkspace,
  updateWorkspace
} from './workspace'
import { mutateWorkspaceFile, readWorkspaceFile, revealWorkspaceFile, writeWorkspaceFile } from './workspace-files'
import { listContextCheckpoints, updateContextCheckpoint } from './context'
import {
  createSession,
  duplicateSession,
  deleteSession,
  getSession,
  listSessions,
  renameSession,
  replaceHistory,
  searchAll,
  setArchived,
  setFavorited
} from './sessions'
import {
  chooseBackupDirectory,
  cleanupAttachments,
  cleanupByAge,
  cleanupPreview,
  clearHistory,
  clearLocalData,
  createBackup,
  exportData,
  getBackupStatus,
  getStats,
  importApply,
  importPreview,
  openDataDirectory,
  restoreBackup,
  scheduleAutomaticBackup,
  vacuum
} from './storage'

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
  'app:getBootstrap': (_req, ctx) => {
    // A renderer reload can arrive before the tab/input debounce expires.
    flushPendingPersists()
    return getBootstrap(ctx.kind)
  },
  'app:openExternal': ({ url }) => openExternal(url),
  'app:copyText': ({ text }) => copyText(text),
  'app:openSessionWindow': (req) => openSessionWindow(req),
  'settings:get': () => getSettings(),
  'settings:update': (patch) => updateSettings(patch),
  'theme:importImage': () => importImage(),
  'theme:saveImage': (req) => saveImage(req),
  'theme:listImages': () => listImages(),
  'theme:readImage': (req) => readImage(req),
  'theme:deleteImage': (req) => deleteImage(req),
  'workspace:list': () => listWorkspaces(),
  'workspace:pick': () => pickWorkspace(),
  'workspace:update': (req) => updateWorkspace(req),
  'workspace:close': ({ id }) => {
    browserManager.closeWorkspace(id)
    return closeWorkspace(id)
  },
  'workspace:listDir': (req) => listDir(req),
  'workspace:readFile': (req) => readWorkspaceFile(req),
  'workspace:writeFile': (req) => writeWorkspaceFile(req),
  'workspace:mutateFile': (req) => mutateWorkspaceFile(req),
  'workspace:revealFile': (req) => revealWorkspaceFile(req),
  'browser:list': ({ workspaceId }) => browserManager.list(workspaceId),
  'browser:open': ({ workspaceId, url, title, profileId, clientTabId }) =>
    browserManager.open({ workspaceId, url, title, profileId, clientTabId, source: 'user' }),
  'browser:navigate': ({ workspaceId, tabId, url }) => {
    const tab = browserManager.get(tabId)
    if (tab?.workspaceId !== workspaceId) throw new Error('浏览器标签不属于当前工作区')
    return browserManager.navigate(tabId, url)
  },
  'browser:close': ({ workspaceId, tabId }) => {
    const tab = browserManager.get(tabId)
    if (tab?.workspaceId !== workspaceId) throw new Error('浏览器标签不属于当前工作区')
    return browserManager.close(tabId)
  },
  'browser:profiles': () => browserManager.listProfiles(),
  'browser:createProfile': ({ name, domains, startUrl }) => {
    const profile = browserManager.createProfile(name, domains, startUrl)
    windows.emitToAll('browser:profilesChanged', browserManager.listProfiles())
    return profile
  },
  'browser:deleteProfile': async ({ id }) => {
    const profile = browserManager.listProfiles().find((item) => item.id === id)
    if (profile === undefined) throw new Error('Profile 不存在')
    if (profile.isDefault) return browserManager.deleteProfile(id)
    await Promise.all(store.listWorkspaces().map((workspace) => clearBrowserProfileState(workspace.id, id)))
    browserManager.deleteProfile(id)
    windows.emitToAll('browser:profilesChanged', browserManager.listProfiles())
  },
  'browser:exportCookies': ({ workspaceId, profileId }, ctx) => {
    const profile = browserManager.listProfiles().find((item) => item.id === profileId)
    if (profile === undefined) throw new Error('Profile 不存在')
    return exportBrowserCookies(ctx.sender, workspaceId, profile)
  },
  'browser:importCookies': ({ workspaceId, profileId }, ctx) => {
    if (!browserManager.listProfiles().some((item) => item.id === profileId)) throw new Error('Profile 不存在')
    return importBrowserCookies(ctx.sender, workspaceId, profileId)
  },
  'browser:clearProfileState': ({ workspaceId, profileId }) => {
    const profile = browserManager.listProfiles().find((item) => item.id === profileId)
    if (profile === undefined) throw new Error('Profile 不存在')
    if (profile.isDefault) throw new Error('默认浏览器不能清除登录态')
    return clearBrowserProfileState(workspaceId, profileId)
  },
  'tabs:getInner': ({ workspaceId }) => {
    const key = innerTabKey(workspaceId)
    flushPendingPersists(key)
    return store.getInnerTabs(workspaceId)
  },
  'session:getInput': ({ sessionId }) => readSessionInput(sessionId),

  // ── 附件(读取走 ncw:// 协议,不占 IPC) ──
  'attachment:upload': (req) => uploadAttachment(req),
  'attachment:pick': (req) => pickAttachments(req),
  'attachment:remove': (req) => removeAttachment(req),
  'attachment:listBySession': (req) => listSessionAttachments(req),

  // ── 会话 / SQLite ──
  'sessions:list': (req) => listSessions(req),
  'sessions:get': (req) => getSession(req),
  'sessions:replaceHistory': (req) => replaceHistory(req),
  'sessions:create': (req) => createSession(req),
  'sessions:duplicate': (req) => duplicateSession(req),
  'sessions:rename': (req) => renameSession(req),
  'sessions:setArchived': (req) => setArchived(req),
  'sessions:setFavorited': (req) => setFavorited(req),
  'sessions:delete': (req) => deleteSession(req),
  'conversations:searchAll': (req) => searchAll(req),
  'context:list': (req) => listContextCheckpoints(req),
  'context:updateCheckpoint': (req) => updateContextCheckpoint(req),
  'storage:getStats': () => getStats(),
  'storage:vacuum': () => vacuum(),
  'storage:openDataDirectory': () => openDataDirectory(),
  'storage:export': (req) => exportData(req),
  'storage:importPreview': (_req, ctx) => importPreview(ctx.sender.id),
  'storage:importApply': (req, ctx) => importApply(req, ctx.sender.id),
  'storage:chooseBackupDirectory': () => chooseBackupDirectory(),
  'storage:getBackupStatus': () => getBackupStatus(),
  'storage:createBackup': (req) => createBackup(req),
  'storage:restoreBackup': (req, ctx) => restoreBackup(req, ctx.sender.id),
  'storage:cleanupPreview': (req) => cleanupPreview(req),
  'storage:cleanupAttachments': () => cleanupAttachments(),
  'storage:cleanupByAge': (req) => cleanupByAge(req),
  'storage:clearHistory': () => clearHistory(),
  'storage:clearLocalData': (req) => clearLocalData(req),

  // ── 步骤 3–5:RunRegistry / AgentSession / 交互 ──
  'agent:run': (req, ctx) => startRun(req, ctx),
  'agent:attach': (req, ctx) => attachRun(req, ctx),
  'agent:abort': (req) => abortRun(req),
  'agent:respondInteraction': respondInteraction,
  'agent:listInteractions': listInteractions,
  'agent:listTools': ({ workspaceId }) => {
    if (store.getWorkspace(workspaceId) === undefined) throw new Error('Workspace does not exist')
    return getTools().info()
  },

  // ── 步骤 8:终端 ──
  'terminal:create': (req, ctx) => terminalHost.create(req, ctx.sender),
  'terminal:kill': ({ id }) => terminalHost.kill(id),
  'terminal:list': ({ workspaceId }) => terminalHost.list(workspaceId),
  'terminal:getBuffer': ({ id }, ctx) => terminalHost.attach(id, ctx.sender),

  // ── 步骤 10:MCP ──
  'mcp:list': () => listMcpServers(),
  'mcp:upsert': (cfg) => upsertMcpServer(cfg),
  'mcp:remove': ({ id }) => removeMcpServer(id),
  'mcp:testConnection': ({ id }) => testMcpConnection(id),
  'mcp:setSecrets': ({ id, values }) => setMcpSecrets(id, values),
  'mcp:getSecretsInfo': ({ id }) => getMcpSecretsInfo(id),

  // ── 搜索服务 ──
  'websearch:list': () => listSearchProviders(),
  'websearch:setEnabled': ({ id, enabled }) => setSearchEnabled(id, enabled),
  'websearch:reorder': ({ ids }) => reorderSearchProviders(ids),
  'websearch:setCredential': ({ id, apiKey }) => setSearchCredential(id, apiKey),
  'websearch:clearCredential': ({ id }) => clearSearchCredential(id),
  'websearch:test': ({ id }) => testSearchProvider(id),

  // ── 网络代理 ──
  'proxy:setPassword': ({ password }) => setProxyPassword(password),
  'proxy:clearPassword': () => clearProxyPassword(),
  'proxy:getPasswordInfo': () => getProxyPasswordInfo(),

  // ── Skill(渐进披露:提示词里只有目录,正文经 `Skill` 工具取)──
  'skills:list': (req) => listSkills(req),
  'skills:setGlobalEnabled': (req) => setSkillGlobalEnabled(req),
  'skills:setWorkspaceActive': (req) => setSkillWorkspaceActive(req),

  // ── 步骤 4 / 13:上游与网关 ──
  'provider:list': () => listProviders(),
  'provider:listModels': ({ providerId }) => listModels(providerId),
  'provider:upsert': (req) => upsertProvider(req),
  'provider:remove': ({ id }) => removeProvider(id),
  'provider:fetchModels': ({ providerId }) => fetchModels(providerId),
  'provider:setAliases': ({ providerId, models }) => setAliases(providerId, models),
  'provider:setCredential': ({ providerId, apiKey }) => setCredential(providerId, apiKey),
  'provider:getCredentialInfo': ({ providerId }) => getCredentialInfo(providerId),
  // Agent 上游已支持三种协议;独立连接测试入口仍待接入。
  'provider:test': todo('provider:test', '步骤 13(独立连接测试入口)'),
  'model:update': (req) => updateModel(req),
  'model:rename': ({ providerId, alias, nextAlias }) => renameModel(providerId, alias, nextAlias),
  'model:remove': ({ providerId, alias }) => removeModel(providerId, alias),
  'modelCatalog:list': () => listUserModelCatalog(),
  'modelCatalog:upsert': (req) => upsertUserModelCatalog(req),
  'modelCatalog:remove': ({ id }) => removeUserModelCatalog(id),
  'usage:getSummary': (window) => store.getUsageSummary(window),
  'usage:getRequestLogs': (query) => store.getUsageRequestLogs(query),
  'usage:getProviderStats': (window) => store.getUsageProviderStats(window),
  'usage:getModelStats': (window) => store.getUsageModelStats(window),
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

/**
 * @param immediate 跳过防抖直接落盘。用于**离散低频且丢不起**的写入
 *   (入队/插话/删除一条排队消息)——它们的频率低到不值得防抖,
 *   而丢失代价远高于「最后一次拖动的 Tab 顺序」。
 */
function persistDebounced(key: string, value: unknown, immediate = false): void {
  const prev = pendingPersists.get(key)
  if (prev) clearTimeout(prev.timer)

  if (immediate) {
    // ★ 必须连 pending 一起清掉:否则先 immediate 写了新值,
    //   之前那个还挂着的定时器过一会儿会把**旧值**盖回去。
    pendingPersists.delete(key)
    store.setKv(key, value)
    return
  }

  const timer = setTimeout(() => {
    pendingPersists.delete(key)
    store.setKv(key, value)
  }, PERSIST_DEBOUNCE_MS)
  // 连值一起存住:退出时要**写掉**它,不是丢掉它
  pendingPersists.set(key, { timer, value })
}

/**
 * 读回未发出的输入。**校验在主进程侧做**,渲染层拿到的要么可用,要么是 null。
 *
 * ★ 读到失效存档时**顺手删键** —— 这就是「30 天兜底清扫」的全部实现。
 * 单独跑一个扫描任务是过度设计:一份存档只有在被读的时候才有意义,
 * 而没人读的键留在 kv 里除了占几 KB 没有别的影响。
 */
function readSessionInput(sessionId: string): SessionInputState | null {
  const key = sessionInputKey(sessionId)
  flushPendingPersists(key)
  const raw = store.getKv<unknown>(key, null)
  if (raw === null) return null
  if (!isValidSessionInput(raw, Date.now())) {
    store.setKv(key, null)
    return null
  }
  return raw
}

/** Flush before reads and app quit so pending UI state survives renderer reloads. */
export function flushPendingPersists(onlyKey?: string): void {
  for (const [key, { timer, value }] of pendingPersists) {
    if (onlyKey !== undefined && key !== onlyKey) continue
    clearTimeout(timer)
    store.setKv(key, value)
    pendingPersists.delete(key)
  }
}

const sendHandlers: SendHandlerMap = {
  'window:ready': ({ kind }, ctx) => {
    windows.markReady(ctx.sender, kind)
    // 握手第一条腿(协议 §7)。一行日志,但它是「渲染层真的跑起来了」
    // 在主进程侧唯一的可观测证据 —— 渲染层的 console 不进这个 stdout。
    console.log(`[ipc] 窗口就绪 · kind=${kind}`)
  },
  'window:titleBarOverlay': (colors, ctx) => applyTitleBarColors(ctx.sender, colors),
  'tabs:persistOuter': ({ kind, state }) => persistDebounced(outerTabKey(kind), state),
  'tabs:persistInner': ({ workspaceId, state }) =>
    persistDebounced(innerTabKey(workspaceId), state),
  'session:persistInput': ({ sessionId, state, immediate }) =>
    persistDebounced(sessionInputKey(sessionId), state, immediate),

  'terminal:write': ({ id, data }) => terminalHost.write(id, data),
  'terminal:resize': ({ id, cols, rows }) => terminalHost.resize(id, cols, rows)
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
      else if (
        error.code === 'unknown' &&
        !(channel === 'sessions:get' && /会话不存在|不存在该会话|session.*not found/i.test(error.message))
      ) {
        console.error(`[ipc] ${channel} 失败:`, err)
      }
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
  registerMcpBridge()
  setBrowserChangeListener((change) => windows.emitToAll('browser:changed', change))
  /*
    ★ 子 run 的启动器。方向是 **ipc 依赖 runtime,runtime 永不依赖 ipc** ——
    反过来写会把 electron 拖进 runtime 的 import 图,`agent-run.test.ts`
    那条无头链路当场就断(见 runtime.ts 文件头)。和 `registerMcpBridge`
    里那次 `setMcpChangeListener` 是同一种接线。
  */
  installChildRunLauncher(startChildRun)
  setSessionChangeListener((workspaceId, renamed) => {
    windows.emitToAll('sessions:changed', { workspaceId, ...(renamed === undefined ? {} : { renamed }) })
  })

  // 自动备份只在启动时按到期判断一次，不依赖渲染层计时器。
  scheduleAutomaticBackup()

  // ★ 必须排在 sweepOrphans 之前:搬完才知道哪些文件还在。
  //   反过来的话,sweep 扫的是空的新目录,而旧目录里的图一张都不在索引对应的位置上。
  migrateLegacyThemesDir()

  // 扫掉两相导入中途放弃留下的孤儿图片。放在这里是因为**此刻 pending 必然是空的**,
  // 所以「不在索引里」就等于「没人要」—— 换成运行期任何一个时刻都不成立。
  sweepOrphans()
}

export { EMPTY_OUTER }
export { shutdownRuns } from './agent'
export { shutdownTerminals }
