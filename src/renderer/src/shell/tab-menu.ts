/**
 * `+` 菜单的合成 —— 内置项 + 插件贡献项。
 *
 * ★ 合并规则(插件排在内置之后、单插件最多 3 项、group 边界画分隔线)全部在
 * `shared/plugin/contribution.ts` 的纯函数里,这里只负责**取数**。
 * 把 clamp 那条留在渲染层等于把一条安全规则托付给一个没人会为它写测试的地方。
 */
import { useMemo } from 'react'
import type { TabPane } from '../../../shared/domain/tab'
import { BUILTIN_TAB_MENU, tabMenuForPane } from '../../../shared/domain/tab'
import { mergeMenuItems, type MergedMenu } from '../../../shared/plugin/contribution'
import { usePluginsStore } from '../stores/plugins'

/**
 * 这一格该显示的菜单。
 *
 * `pane` 同时是**过滤条件**与 `when` 表达式的 context key —— 插件写
 * `"when": "pane == right"` 就能只在右侧那格出现。P1 只支持这一个 key;
 * `resourceExtname` 之类要等文件树右键那一期。
 */
export function useTabMenu(pane: TabPane): MergedMenu {
  const catalog = usePluginsStore((state) => state.catalog)
  const menuItems = usePluginsStore((state) => state.menuItems)
  return useMemo(() => {
    const builtin = tabMenuForPane(BUILTIN_TAB_MENU, pane)
    const contributed = tabMenuForPane(menuItems('tabBar/new', { pane }), pane)
    return mergeMenuItems(builtin, contributed)
    // catalog 进依赖数组:装/禁/卸插件之后这份菜单必须立刻跟着变。
  }, [pane, catalog, menuItems])
}
