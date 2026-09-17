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
import { registerPluginMessages, translate, unregisterPluginMessages } from '../i18n'
import { invoke } from '../services/ipc'
import { toast } from './toast'

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
    /*
      ★ **失败必须说出来。**

      调用点(`shell/Dock.tsx`、`shell/commands.ts`)都是 `void runCommand(...)` ——
      即发即忘。以前这里直接把 rejection 抛出去,于是一次失败的点击表现为
      「点了没反应」:没有提示、没有日志、控制台干净。而插件命令会失败的
      地方很多(没激活、能力没批、路径被拒、插件自己的代码抛了),
      用户唯一能做的就是反复点。

      收口在这一层而不是每个调用点:漏一个调用点就漏一种静默失败。
    */
    try {
      await invoke('plugins:runCommand', { pluginId, commandId })
    } catch (error) {
      /*
        面向用户的是一句人话;原始错误进 console 供排查 —— 主进程那边抛出来的
        是英文诊断句(比如 `plugin acme.excalidraw could not be activated`),
        它不该出现在界面上,但排查时又不能没有。`[plugins]` 前缀同 App.tsx。
      */
      console.error(`[plugins] ${pluginId} 的命令 ${commandId} 执行失败`, error)
      toast.error(translate('plugins.commandFailed', { plugin: pluginId }), `plugin-command-${commandId}`)
    }
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
    /*
      ★ **包内的 l10n 优先,清单兜底。** 顺序反过来的话,包里明明写了
      「新建绘图」,菜单上却一直是 `excalidraw.new` —— 而兜底那一份
      看起来「有值」,所以不会有任何地方报错。
    */
    const bundled = plugin.messages ?? {}
    const fallback = pluginMessageFallback(plugin)
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const dict = { ...fallback[locale], ...bundled[locale] }
      if (Object.keys(dict).length === 0) continue
      try {
        registerPluginMessages(plugin.id, locale, dict)
      } catch {
        // 注册被拒(前缀不对/超配额)只影响这一个插件的文案,不该打断别的。
      }
    }
  }
}

/**
 * 包没带 l10n 时的**兜底**文案。
 *
 * ★ 兜底值是 `displayName`,不是 `command.command` —— 后者是**协议标识符**
 * (`excalidraw.new`),把它显示在菜单上等于把内部标识漏给用户,而且看起来
 * 像一条没翻译的 key,没人分得清它是「缺翻译」还是「本来就长这样」。
 * 显示名至少是作者自己起的、给人看的字。
 */
function pluginMessageFallback(plugin: InstalledPlugin): Record<'zh-CN' | 'en-US', Record<string, string>> {
  const dict: Record<string, string> = {}
  for (const command of plugin.manifest.contributes.commands) {
    dict[`plugin.${plugin.id}.${command.title.slice(1, -1)}`] = plugin.manifest.displayName
  }
  return { 'zh-CN': dict, 'en-US': dict }
}
