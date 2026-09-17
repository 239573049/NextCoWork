/**
 * 插件的 IPC 面 —— 渲染层与插件系统之间的全部通道。
 *
 * ★ **和插件自己那条 RPC 是两条完全不同的通道。** 这一条是给**主窗口**用的
 * (受信任的渲染层,走 `shared/ipc/contract.ts` 的三张白名单);插件那条在
 * `plugin/host-window.ts`,独立协议、独立白名单、独立能力校验。
 * 两者唯一的交点是 `PluginManager`,而它对两边的信任级别是不一样的。
 */
import { app, dialog } from 'electron'
import { join } from 'node:path'
import type { PluginPermission } from '../../shared/plugin/permission'
import type { PluginActivity, PluginCatalog } from '../../shared/plugin/state'
import { PLUGINS_DIR, PluginManager } from '../plugin/manager'
import { ElectronPluginRuntime, pluginPreloadPath } from '../plugin/host-window'
import { recentActivity } from '../plugin/diagnostics'
import { store } from '../state/store'
import {
  getHost,
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
    currentWorkspace: () => {
      /*
        ★ 「当前工作区」取的是**最近激活的那一个**。插件的路径类能力全部以它
        为根 —— 没有工作区时是空串,而 `narrowWorkspacePath` 对空根一律拒绝。
        这比回落到临时目录诚实:插件宁可一步都走不动,也不要往一个谁也不会看的
        目录里写东西然后报告「已完成」(同 `runtime.ts` 的 `workspaceRootFor`)。
      */
      const workspace = store.listWorkspaces()[0]
      return { id: workspace?.id ?? '', rootPath: workspace?.rootPath ?? '' }
    },
    approve: async (pluginId, summary) => {
      /*
        ★ 这里**必须**接进既有的八层权限链。第一版先走一次系统级确认框:
        它保证「插件写文件 / 跑命令」不会在用户完全不知情的情况下发生。
        接进 `decideAfterHooks` 的完整实现见计划 P2 —— 那一步之后,
        插件的写操作和模型自己写文件会走**完全同一条**审批路径。
      */
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        message: summary.kind === 'write' ? `Plugin ${pluginId} wants to write` : `Plugin ${pluginId} wants to run a command`,
        detail: summary.detail
      })
      return response === 0
    },
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
  try {
    await manager.install(req.path)
  } catch (error) {
    throw new IpcError('unknown', (error as Error).message)
  }
  return listPlugins()
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
