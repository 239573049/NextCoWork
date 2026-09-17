/**
 * 渲染层这一侧的插件状态。
 *
 * ★ **只读投影,没有任何句柄。** 这里存的是一份 `PluginCatalog`(可结构化克隆
 * 的纯数据),所有写操作都是一次 IPC —— 主进程返回新的 catalog,这里整份换掉。
 *
 * 为什么不做增量:插件数量是个位数,而增量协议要多一套「我这份过期了吗」的
 * 判断。`mcp:changed` 当初就是那么走弯路的 —— 推了一条没有内容的通知,
 * 渲染层还得自己再拉一次,于是两份状态之间永远差着一个往返。
 */
import { create } from 'zustand'
import type { InstalledPlugin, PluginActivity, PluginCatalog } from '../../../shared/plugin/state'
import type { PluginMarketItem } from '../../../shared/plugin/market'
import type { PluginPermission } from '../../../shared/plugin/permission'
import {
  evaluateWhen,
  normalizeMenuIcon,
  parseMenuGroup,
  type TabMenuItem,
  type WhenContext
} from '../../../shared/plugin/contribution'
import { registerPluginMessages, unregisterPluginMessages } from '../i18n'
import { invoke } from '../services/ipc'

interface PluginsState {
  catalog: PluginCatalog
  activity: PluginActivity[]
  loading: boolean
  /** 市场列表。**和已装列表分开存** —— 它们的生命周期完全不同 */
  market: PluginMarketItem[]
  marketLoading: boolean
  marketError: string | null
  load: () => Promise<void>
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>
  uninstall: (pluginId: string) => Promise<void>
  installFromPicker: () => Promise<void>
  grant: (pluginId: string, permissions: PluginPermission[]) => Promise<void>
  revoke: (pluginId: string, permissions: PluginPermission[]) => Promise<void>
  loadActivity: (pluginId?: string) => Promise<void>
  runCommand: (pluginId: string, commandId: string) => Promise<void>
  loadMarket: (query?: { q?: string; category?: string }) => Promise<void>
  installFromMarket: (slug: string) => Promise<void>
  /** 某个菜单挂载点上的插件贡献项,已归一成 `TabMenuItem` */
  menuItems: (menuId: string, context: WhenContext) => TabMenuItem[]
}

const EMPTY: PluginCatalog = { plugins: [], hostVersion: '' }

export const usePluginsStore = create<PluginsState>((set, get) => ({
  catalog: EMPTY,
  activity: [],
  loading: false,
  market: [],
  marketLoading: false,
  marketError: null,

  async load() {
    set({ loading: true })
    try {
      const catalog = await invoke('plugins:list', undefined)
      applyCatalog(catalog)
      set({ catalog, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  async setEnabled(pluginId, enabled) {
    const catalog = await invoke('plugins:setEnabled', { pluginId, enabled })
    applyCatalog(catalog)
    set({ catalog })
  },

  async uninstall(pluginId) {
    const catalog = await invoke('plugins:uninstall', { pluginId })
    unregisterPluginMessages(pluginId)
    applyCatalog(catalog)
    set({ catalog })
  },

  async installFromPicker() {
    const picked = await invoke('plugins:pickPackage', undefined)
    if (picked === null) return
    const catalog = await invoke('plugins:installPackage', { path: picked.path })
    applyCatalog(catalog)
    set({ catalog })
  },

  async grant(pluginId, permissions) {
    const catalog = await invoke('plugins:grantPermissions', { pluginId, permissions })
    applyCatalog(catalog)
    set({ catalog })
  },

  async revoke(pluginId, permissions) {
    const catalog = await invoke('plugins:revokePermissions', { pluginId, permissions })
    applyCatalog(catalog)
    set({ catalog })
  },

  async loadActivity(pluginId) {
    const activity = await invoke('plugins:activity', { ...(pluginId === undefined ? {} : { pluginId }) })
    set({ activity })
  },

  async runCommand(pluginId, commandId) {
    await invoke('plugins:runCommand', { pluginId, commandId })
  },

  async loadMarket(query = {}) {
    set({ marketLoading: true, marketError: null })
    try {
      set({ market: await invoke('plugins:marketList', query), marketLoading: false })
    } catch (error) {
      /*
        ★ 市场拉不动**不是空列表**。给空列表的话,界面上写着「还没有插件」,
        而真相是「连不上市场」—— 用户会以为这个市场是空的,而不是去检查网络。
      */
      set({ marketLoading: false, marketError: error instanceof Error ? error.message : String(error) })
    }
  },

  async installFromMarket(slug) {
    const catalog = await invoke('plugins:installMarket', { slug })
    applyCatalog(catalog)
    set({ catalog })
  },

  menuItems(menuId, context) {
    const out: TabMenuItem[] = []
    for (const plugin of get().catalog.plugins) {
      // ★ 禁用的插件,菜单项必须消失 —— 否则点了之后是一条静默失败。
      if (!plugin.enabled || plugin.status === 'error' || plugin.status === 'pending-approval') continue
      const contributions = plugin.manifest.contributes.menus[menuId] ?? []
      for (const contribution of contributions) {
        if (!evaluateWhen(contribution.when, context)) continue
        const command = plugin.manifest.contributes.commands.find((c) => c.command === contribution.command)
        if (command === undefined) continue
        const { group, order } = parseMenuGroup(contribution.group)
        out.push({
          id: `${plugin.id}:${contribution.command}`,
          // 清单里写的是 `%cmd.new%`,注册进 i18n 的是 `plugin.<id>.cmd.new`。
          titleKey: `plugin.${plugin.id}.${command.title.slice(1, -1)}`,
          icon: normalizeMenuIcon(command.icon),
          group,
          order,
          pluginId: plugin.id,
          action: { kind: 'command', commandId: contribution.command }
        })
      }
    }
    return out
  }
}))

/**
 * catalog 到手之后把插件文案注册进 i18n。
 *
 * ★ 在**这里**做而不是在设置页里做:菜单项、命令名在插件被激活之前就要显示,
 * 而菜单本身就是激活事件的来源。等到打开设置页才注册的话,没开过设置页的
 * 用户看到的是一排 key。
 */
function applyCatalog(catalog: PluginCatalog): void {
  for (const plugin of catalog.plugins) {
    const bundles = pluginMessageBundles(plugin)
    for (const [locale, dict] of Object.entries(bundles)) {
      try {
        registerPluginMessages(plugin.id, locale as 'zh-CN' | 'en-US', dict)
      } catch {
        // 注册被拒(前缀不对/超配额)只影响这一个插件的文案,不该打断别的。
      }
    }
  }
}

/**
 * 从清单里**兜底**生成一份文案表。
 *
 * 真正的文案来自包内的 l10n bundle(主进程读、经 catalog 带过来)——
 * 这里只是在包没带 l10n 时,让菜单至少显示 `displayName` 而不是一排 key。
 */
function pluginMessageBundles(plugin: InstalledPlugin): Record<string, Record<string, string>> {
  const fallback: Record<string, string> = {}
  for (const command of plugin.manifest.contributes.commands) {
    fallback[`plugin.${plugin.id}.${command.title.slice(1, -1)}`] = command.command
  }
  return { 'zh-CN': fallback, 'en-US': fallback }
}
