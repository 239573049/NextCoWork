/**
 * 扩展面板的列表过滤 —— 纯函数，**故意放在 `.ts` 而不是组件里**。
 *
 * `vitest.config.ts` 的 include 是 `src/**\/*.test.ts`，不含 `.tsx`：写在组件里的
 * 逻辑一行也测不到。先例见 `views/skills/use-skill.ts`。
 */

export type ScopeFilter = 'all' | 'global' | 'project'

export interface FilterableRow {
  name: string
  description: string
  scope: string
}

/**
 * 搜索 + 作用域过滤。
 *
 * ★ 搜索同时看名字和描述：用户记得住「那个部署相关的命令」却想不起它叫什么，
 *   是比记错名字更常见的情形。
 * ★ `builtin` 的行在筛「全局」「本工作区」时都不出现 —— 它既不在 appData 里
 *   也不在工作区里，硬归进任何一边都是撒谎。
 */
export function filterRows<T extends FilterableRow>(
  rows: readonly T[],
  query: string,
  scope: ScopeFilter
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (scope !== 'all' && row.scope !== scope) return false
    if (needle === '') return true
    return `${row.name} ${row.description}`.toLocaleLowerCase().includes(needle)
  })
}
