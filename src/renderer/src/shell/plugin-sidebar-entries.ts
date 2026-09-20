/**
 * 侧边栏上那几条**插件贡献的入口**。
 *
 * ## 为什么抽成独立文件而不是写进 `Sidebar.tsx`
 *
 * `Sidebar.tsx` 已经 700 多行,而这段的全部输入是一份 catalog、输出是一个数组 ——
 * 抽出来之后它可以在 node 环境里直测(AGENTS.md §9 的「可测的纯逻辑往 `.ts` 抽」),
 * 而 `Sidebar.tsx` 里只剩一次 `.map()`。
 *
 * ## 这里只出「网页应用」
 *
 * `contributes.webApps` 里 `entry: 'sidebar'`(缺省)的那些。`sidebar/nav` 菜单
 * 贡献走的是另一条路(`menuItems('sidebar/nav', …)`),它的动作是**命令**,
 * 而这里的动作是「打开这个网页」—— 两者的点击后果不同,不合并成一张表。
 */
import type { PluginCatalog } from '../../../shared/plugin/state'
import { isRunnable } from '../../../shared/plugin/state'
import { normalizeMenuIcon, type MenuIconName } from '../../../shared/plugin/contribution'

export interface PluginSidebarEntry {
  /** 稳定 key:`<pluginId>:<webAppId>` */
  id: string
  pluginId: string
  webAppId: string
  /** 已经拼好的 l10n key(`plugin.<id>.<key>`),渲染处 `t()` 它 */
  titleKey: string
  icon: MenuIconName
}

/**
 * 这一刻侧边栏上应该有哪几条插件入口。
 *
 * ★ **禁用 / 待批准 / 装载失败的插件一条都不出**(`isRunnable`)。
 * 出了的话,点下去是一次静默失败 —— 用户会以为是应用坏了,而不是插件被关了。
 * 判定复用 `shared/plugin/state.ts` 那一份,不在这里重写。
 */
export function pluginSidebarEntries(catalog: PluginCatalog): PluginSidebarEntry[] {
  const out: PluginSidebarEntry[] = []
  for (const plugin of catalog.plugins) {
    if (!isRunnable(plugin)) continue
    for (const webApp of plugin.manifest.contributes.webApps) {
      if ((webApp.entry ?? 'sidebar') !== 'sidebar') continue
      out.push({
        id: `${plugin.id}:${webApp.id}`,
        pluginId: plugin.id,
        webAppId: webApp.id,
        // 清单里写的是 `%app.home%`,注册进 i18n 的是 `plugin.<id>.app.home`
        titleKey: `plugin.${plugin.id}.${webApp.title.slice(1, -1)}`,
        icon: normalizeMenuIcon(webApp.icon)
      })
    }
  }
  /*
    ★ 排序必须是**确定的**:catalog 里的顺序来自目录遍历,而那个顺序在不同平台上
    不一样 —— 不定序的话,同一台机器重启之后侧边栏上这几条会换位置。
    同 `contribution.ts` 里 `byGroupThenOrder` 末尾那条 tie-break 的理由。
  */
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
