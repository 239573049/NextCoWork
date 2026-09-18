/**
 * 插件的 IPC 面 —— 渲染层与插件系统之间的全部通道。
 *
 * ★ **和插件自己那条 RPC 是两条完全不同的通道。** 这一条是给**主窗口**用的
 * (受信任的渲染层,走 `shared/ipc/contract.ts` 的三张白名单);插件那条在
 * `plugin/host-window.ts`,独立协议、独立白名单、独立能力校验。
 * 两者唯一的交点是 `PluginManager`,而它对两边的信任级别是不一样的。
 */
import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import type { ResolvedTheme } from '../../shared/domain/settings'
import { pluginAppearance } from '../plugin/protocol'
import type { PluginPermission } from '../../shared/plugin/permission'
import type { PluginActivity, PluginCatalog } from '../../shared/plugin/state'
import { PLUGINS_DIR, PluginManager } from '../plugin/manager'
import { ElectronPluginRuntime, pluginPreloadPath } from '../plugin/host-window'
import { recentActivity } from '../plugin/diagnostics'
import { store } from '../state/store'
import {
  getHost,
  getTools,
  installPluginContextProvider,
  installPluginInterceptor,
  installPluginToolProvider
} from '../runtime'
import { windows } from '../window/registry'
import { IpcError } from './errors'

let manager: PluginManager | null = null

/** 没起来时返回一份空 catalog —— 界面不该因为插件系统没初始化就打不开。 */
function emptyCatalog(): PluginCatalog {
  return { plugins: [], hostVersion: app.getVersion() }
}

export function pluginManager(): PluginManager | null {
  return manager
}

/**
 * 主题变了,播给订阅过的插件。
 *
 * ★ 调用点有两个 —— `ipc/app.ts` 的 `registerThemeBridge`(跟随系统时系统切换)
 * 和 `ipc/settings.ts`(用户手动改档位)。两处都已经在 `emitToAll('theme:changed')`,
 * 这一行紧跟其后。**漏掉任意一处**的表现都是「某一种切换方式下插件不跟随」,
 * 而用户不会意识到这两条是不同的路径。
 *
 * 插件系统没起来(manager 为 null)时什么都不做 —— 主题切换不该因此报错。
 */
export function notifyPluginsThemeChanged(appearance: ResolvedTheme): void {
  manager?.notifyAppearanceChanged(appearance)
}

export async function startPlugins(): Promise<void> {
  if (manager !== null) return
  const host = getHost()
  const runtime = new ElectronPluginRuntime(
    (pluginId, request) => {
      const current = manager
      if (current === null) {
        return Promise.resolve({ id: request.id, ok: false as const, error: { code: 'internal_error' as const, message: 'plugin system is not running' } })
      }
      return current.handleRequest(pluginId, request)
    },
    pluginPreloadPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  )

  manager = new PluginManager({
    host,
    runtime,
    pluginRoot: join(host.paths.userData(), PLUGINS_DIR),
    hostVersion: app.getVersion(),
    getKv: (key, fallback) => store.getKv(key, fallback),
    setKv: (key, value) => { store.setKv(key, value) },
    currentAppearance: () => pluginAppearance(),
    currentWorkspace: () => {
      /*
        ★ 「当前工作区」优先取**渲染层上报的那一个**(`workspace:setActive`,
        按窗口记在 `windows` 里)。插件的路径类能力全部以它为根 —— 没有工作区时
        是空串,而 `narrowWorkspacePath` 对空根一律拒绝。这比回落到临时目录
        诚实:插件宁可一步都走不动,也不要往一个谁也不会看的目录里写东西
        然后报告「已完成」(同 `runtime.ts` 的 `workspaceRootFor`)。

        ★★ **以前这里取的是 `listWorkspaces()[0]`** —— 按 last_opened_at 倒序的
        第一条。那个时间戳记的是「何时最后一次**打开**」,在已经开着的几个工作区
        之间切 Tab 完全不动它。于是用户停在 B、点「新建绘图」,文件落进了 A。
        上报值拿不到时(窗口还没握手完、或者这个窗口一个工作区都没开)才退回
        那个近似值 —— 它至少不会是个随机答案。

        ★★★ **远程工作区(environment.kind === 'connection')一律排除**,
        空根交给 narrow 去拒。插件宿主的 fs 是**本地** node fs,远程工作区的
        rootPath(比如 SSH 机器上的 /root)在本机不存在 —— 不排除的话,
        写入会在「往上找存在祖先」时一路爬到文件系统根,报一句指向不了
        任何东西的 `path cannot be resolved`。而更糟的另一条路 —— 静默把文件
        写进**另一个**本地工作区 —— 绝对不能发生:用户看着 A 工作区点的新建,
        文件却出现在 B 里。所以上报值指向远程工作区时**也返回空根**,
        而不是接着往下找一个本地的顶上。

        远程工作区里插件暂时一步都走不动,这是**当前能力边界**,不是 bug;
        等插件 fs 支持远程连接时,把这段判断去掉即可。
      */
      const isLocal = (w: { environment?: { kind?: string } }): boolean =>
        (w.environment?.kind ?? 'local') !== 'connection'
      const all = store.listWorkspaces()
      const reported = windows.activeWorkspaceOfFocused()
      if (reported !== undefined) {
        const active = all.find((w) => w.id === reported)
        if (active !== undefined) {
          return isLocal(active) ? { id: active.id, rootPath: active.rootPath } : { id: '', rootPath: '' }
        }
      }
      const workspace = all.find(isLocal)
      return { id: workspace?.id ?? '', rootPath: workspace?.rootPath ?? '' }
    },
    approve: async (pluginId, summary) => {
      /*
        ★ **只剩跑命令还走这里。** 写文件 / 删文件原本也逐次弹这个框,
        而那一问是冗余的:调用走到 `rpc.ts` 之前,`manager.ts` 的能力门
        已经查过 `workspace.write` 在不在该插件的 `granted` 集合里,
        那个集合是用户在插件详情页显式批过、并落盘在 kv `plugins.state`
        里的。同一个问题问两遍,表现就是「每新建一张白板都要批一次」。

        `exec` 留着,因为它是另一个风险量级 —— 而且它此前一直被
        `allowedCommands: []` 堵死在参数门,这一版才刚刚变得可达。

        这个框仍然是**占位实现**:它拼的是裸英文句子,而本仓约定主进程
        只传 l10n key。真正的修法是接进渲染层的 `InteractionGate`、
        复用「以后都允许」那套规则(计划 P2),不在这一版里。
      */
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        message: `Plugin ${pluginId} wants to run a command`,
        detail: summary.detail
      })
      return response === 0
    },
    /*
      ★ 插件删文件的唯一落点。**失败不降级为永久删除** —— `rpc.ts` 那边
      拿到抛错就把整条调用拒掉。撤掉逐次确认框之后,可恢复性只剩这一层。
    */
    trash: async (absolutePath) => { await shell.trashItem(absolutePath) },
    emitChanged: () => { windows.emitToAll('plugins:changed', undefined) },
    publishMessages: (pluginId, locale, dict) => {
      /*
        ★ 同一个「插件 + 语言」**替换**而不是追加。插件每次重新装载都会再报一遍
        自己的 bundle(启用 / 禁用 / 重装 / 升级各一次),追加的话这个数组会一直
        长,而 `listPlugins` 每次都要遍历它。
      */
      const existing = pendingMessages.findIndex((item) => item.pluginId === pluginId && item.locale === locale)
      if (existing === -1) pendingMessages.push({ pluginId, locale, dict })
      else pendingMessages[existing] = { pluginId, locale, dict }
      windows.emitToAll('plugins:changed', undefined)
    },
    requestPermissions: async (pluginId, permissions, reasonKey) => {
      /*
        ★ 运行期申请。`reasonKey` 是**l10n key**,不是文案 —— 主进程新增代码
        一律只传 key(计划 §8.3)。这里暂时把 key 原样显示在系统对话框上;
        接进渲染层的授权面板之后它会被 `t()` 渲染成人话。
      */
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        message: `Plugin ${pluginId} is asking for: ${permissions.join(', ')}`,
        detail: reasonKey
      })
      return response === 0
    },
    showMessage: (pluginId, kind, messageKey, params) => {
      windows.emitToAll('plugins:message', { pluginId, kind, messageKey, params })
    },
    /*
      ★ 只广播,**不在这里开 Tab**。Tab 是渲染层的概念(放哪一格、哪个 dock
      group、同一个文件已经开着时要不要复用),主进程要开的话就得把那整套布局
      规则抄一份 —— 而抄出来的那份一定会和 `stores/tabs.ts` 分叉。
    */
    openCustomEditor: (pluginId, viewType, path) => {
      windows.emitToAll('plugins:openCustomEditor', { pluginId, viewType, path })
    },
    onToolsChanged: () => {
      /*
        插件工具变了 —— 下一次装配会重新问一遍 provider(见 `runtime.ts` 的
        `registerToolProvider`),所以这里只需要让界面知道。
      */
      windows.emitToAll('plugins:changed', undefined)
    },
    /*
      ★ catalog 投影用同一个进程内 namer 单例 `getTools()` 预留 externalName ——
      插件工具真正 register 也走它(经 `installPluginToolProvider`),记忆化保证同名。
    */
    reserveName: (internalId) => getTools().reserveName(internalId),
    unpublishMessages: (pluginId) => {
      for (let i = pendingMessages.length - 1; i >= 0; i -= 1) {
        if (pendingMessages[i]?.pluginId === pluginId) pendingMessages.splice(i, 1)
      }
      windows.emitToAll('plugins:changed', undefined)
    }
  })

  await manager.start()

  /*
    声明了 `onStartup` 的已启用插件,此刻唤醒。

    ★ **只唤醒声明了的**,不是全部:`activationEvents` 是插件自己说「我什么时候
      需要活」。全量唤醒等于把这套机制整个作废,每个装了的插件开机就各起一个
      隐藏窗口 —— 用户只是装了它,没让它常驻。

    ★ **即发即忘**:启动不该被任何一个插件卡住。失败的 wake 已经把原因写进
      了 `record.diagnostics`,插件详情页能看到;这里不再打扰启动流程。
  */
  for (const plugin of manager.catalog().plugins) {
    if (!plugin.enabled) continue
    if (!plugin.manifest.activationEvents.includes('onStartup')) continue
    void manager.wake(plugin.id).catch(() => undefined)
  }

  /*
    ★ 两条接线都**在 start 之后**:装载期可能已经发现了坏包,而那些插件
      不该出现在工具表里。provider 每次装配现问一遍,所以这里只接一次。
  */
  installPluginToolProvider(() => manager?.contributedTools() ?? [])
  installPluginInterceptor((input) => manager?.intercept(input) ?? Promise.resolve({}))
  installPluginContextProvider((input) => manager?.provideContext(input) ?? Promise.resolve(''))
}

/**
 * 插件文案的暂存区。
 *
 * ★ 为什么不直接推给渲染层:`plugins:list` 的响应里已经带着每个插件的清单,
 * 而文案要跟着 catalog 一起到达 —— 分两条路送的话,菜单会先以 key 的样子
 * 出现一帧,再变成文字。所以这里攒着,由 `listPlugins` 一次带出去。
 *
 * ★★ 这段曾经是**死代码**:数组只进不出(`drainPluginMessages` 全仓无人调用),
 * 于是包里的 l10n 永远到不了渲染层,菜单一直显示 `excalidraw.new` 这种
 * 命令 id。修的时候注意:**读的时候不能清空** —— `plugins:list` 会被反复调用
 * (每次 catalog 变动渲染层都重取一次),清掉之后第二次就只剩 key 了。
 */
const pendingMessages: { pluginId: string; locale: string; dict: Record<string, string> }[] = []

export async function shutdownPlugins(): Promise<void> {
  /*
    ★ 先摘接线再关。反过来的话,收尾期间进来的一次工具装配会问一个
    正在销毁的 manager —— 而那次失败会以「工具不存在」的名义出现在转录里。
  */
  installPluginInterceptor(null)
  installPluginContextProvider(null)
  await manager?.shutdown()
  manager = null
}

/**
 * 全部已装插件 + 它们各自的文案。
 *
 * ★ 文案**挂进 catalog**,不另开一条 IPC:菜单项在插件被激活之前就要画出来,
 * 而菜单本身就是激活事件的来源。分两条路送的话,菜单会先以 key 的样子出现
 * 一帧再变成文字。
 *
 * ★ 这里**不清空** `pendingMessages`:这个函数每次 catalog 变动都会被调一次
 * (渲染层收到 `plugins:changed` 就重取),清掉的话第二次返回的就没有文案了,
 * 菜单又变回一排 key。
 */
export function listPlugins(): PluginCatalog {
  const catalog = manager?.catalog() ?? emptyCatalog()
  if (pendingMessages.length === 0) return catalog

  const byPlugin = new Map<string, Record<string, Record<string, string>>>()
  for (const { pluginId, locale, dict } of pendingMessages) {
    const locales = byPlugin.get(pluginId) ?? {}
    locales[locale] = dict
    byPlugin.set(pluginId, locales)
  }

  return {
    ...catalog,
    plugins: catalog.plugins.map((plugin) => {
      const messages = byPlugin.get(plugin.id)
      return messages === undefined ? plugin : { ...plugin, messages }
    })
  }
}

export async function setPluginEnabled(req: { pluginId: string; enabled: boolean }): Promise<PluginCatalog> {
  await manager?.setEnabled(req.pluginId, req.enabled)
  return listPlugins()
}

export async function uninstallPlugin(req: { pluginId: string }): Promise<PluginCatalog> {
  await manager?.uninstall(req.pluginId)
  return listPlugins()
}

export async function pickPluginPackage(): Promise<{ path: string; name: string } | null> {
  const result = await dialog.showOpenDialog({
    // 目录与 ZIP 两条来源共用一个选择器 —— 作者在 `dev --watch` 时装目录,
    // 用户从市场之外装包时装 ZIP。
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Plugin package', extensions: ['zip'] }]
  })
  const path = result.filePaths[0]
  if (result.canceled || path === undefined) return null
  return { path, name: path.split(/[\\/]/).pop() ?? path }
}

export async function installPlugin(req: { path: string }): Promise<PluginCatalog> {
  if (manager === null) throw new IpcError('unknown', 'plugin system is not running')
  /*
    ★ key 里带上路径,不是一个固定的 `'local'`:多窗口、或者接连装两个
    本地包时,两条进度会挤在同一个 key 上互相覆盖 —— 表现是先装的那条
    进度条被后装的接管,看起来像"卡住之后忽然跳完了"。
  */
  const key = `local:${req.path}`
  // 本地包没有下载阶段。校验 + 解压通常是毫秒级,但大包解压得出来也要几秒,
  // 而在那几秒里右上角那颗按钮以前是完全没有反馈的。
  emitInstallProgress(key, 'installing')
  try {
    await manager.install(req.path)
  } catch (error) {
    emitInstallProgress(key, 'failed', { messageKey: 'plugins.installPackageFailed' })
    throw new IpcError('unknown', (error as Error).message)
  }
  const catalog = listPlugins()
  emitInstallProgress(key, 'done')
  return catalog
}

/**
 * 装一个插件走到哪一步了 —— 市场安装与本地安装共用。
 *
 * ★ 全局广播而不是定向推:装插件是全局副作用,别的窗口的市场页也该看到
 * 那颗按钮在跑。形状同 `provider-auth.ts` 的 `emitPhase()` —— 可选字段一律
 * 展开进去,不给 `undefined`(它穿过结构化克隆会变成「有这个键但没有值」)。
 */
export function emitInstallProgress(
  key: string,
  phase: 'preparing' | 'downloading' | 'installing' | 'done' | 'failed',
  extra: { received?: number; total?: number; messageKey?: string } = {}
): void {
  windows.emitToAll('plugins:installProgress', {
    key,
    phase,
    ...(extra.received === undefined ? {} : { received: extra.received }),
    ...(extra.total === undefined ? {} : { total: extra.total }),
    ...(extra.messageKey === undefined ? {} : { messageKey: extra.messageKey })
  })
}

export function grantPluginPermissions(req: { pluginId: string; permissions: PluginPermission[] }): PluginCatalog {
  manager?.grant(req.pluginId, req.permissions)
  return listPlugins()
}

export function revokePluginPermissions(req: { pluginId: string; permissions: PluginPermission[] }): PluginCatalog {
  manager?.revoke(req.pluginId, req.permissions)
  return listPlugins()
}

export function pluginActivity(req: { pluginId?: string }): PluginActivity[] {
  return recentActivity(req.pluginId)
}

export async function confirmPluginClose(req: { path?: string }): Promise<{ safe: boolean }> {
  // 插件系统没起来 = 没有插件编辑器 = 关起来是安全的。
  return { safe: manager === null ? true : await manager.saveBeforeClose(req) }
}

export function getPluginConfiguration(req: { pluginId: string }): Record<string, boolean | string | number> {
  return manager?.configuration(req.pluginId) ?? {}
}

export function setPluginConfiguration(req: {
  pluginId: string
  key: string
  value: boolean | string | number | null
}): Record<string, boolean | string | number> {
  manager?.setConfiguration(req.pluginId, req.key, req.value)
  return getPluginConfiguration(req)
}

export async function runPluginCommand(req: { pluginId: string; commandId: string }): Promise<void> {
  if (manager === null) throw new IpcError('unknown', 'plugin system is not running')
  try {
    await manager.runCommand(req.pluginId, req.commandId)
  } catch (error) {
    throw new IpcError('unknown', (error as Error).message)
  }
}

/**
 * 用户点了实时工具卡片上的按钮。**即发即忘**:动作到不了(工具已结束 / callId
 * 不属于该插件)时静默丢弃 —— 一次没送到的点击不该弹错,那是竞态,不是故障。
 */
export async function deliverPluginCardAction(req: {
  pluginId: string
  callId: string
  actionId: string
  value?: unknown
}): Promise<void> {
  await manager?.deliverCardAction(req.pluginId, req.callId, req.actionId, req.value)
}
