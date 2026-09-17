/**
 * 命令注册表 —— 「这个应用此刻能做哪些事」的唯一出处。
 *
 * ## 为什么之前没有它
 *
 * 命令面板(`shell/SearchPalette.tsx`)在此之前只做会话全文搜索,cmdk 已经就绪
 * 但**没有命令这个概念**;快捷键是 `AppShell.tsx` 里一个孤立的 keydown;
 * `+` 菜单里那几项是第三套写法。三处各自知道「能做什么」的一部分,
 * 而插件要贡献的恰恰是同一件东西 —— 不收口的话,一条插件命令得在三个地方
 * 各接一遍,而且三处会慢慢长歪。
 *
 * ## 这一层只描述,不执行
 *
 * `Command.run` 是一个闭包,但注册表本身**不持有任何 store** ——
 * 内置命令由 `useCommands()` 在组件里现拼(那里才拿得到 store 的 action),
 * 插件命令统一走一条 IPC。这样这个文件可以在 node 环境里直测。
 */
import { useMemo } from 'react'
import type { MenuIconName } from '../../../shared/plugin/contribution'
import { normalizeMenuIcon } from '../../../shared/plugin/contribution'
import { usePluginsStore } from '../stores/plugins'

export interface Command {
  /** 稳定 id:内置 `builtin.*`,插件 `<pluginId>:<commandId>` */
  id: string
  /** ★ key 不是文案 */
  titleKey: string
  icon: MenuIconName
  /** `CmdOrCtrl+K` 这类。显示与匹配共用它 */
  accelerator?: string
  /** 贡献者。`undefined` = 内置 */
  pluginId?: string
  run: () => void | Promise<void>
}

/**
 * 插件贡献的命令。
 *
 * ★ 禁用 / 待批准 / 装载失败的插件**一条都不出** —— 命令面板里躺着一条点了
 * 没反应的命令,比它根本不出现要糟:用户会以为是应用坏了。
 */
export function usePluginCommands(): Command[] {
  const catalog = usePluginsStore((state) => state.catalog)
  const runCommand = usePluginsStore((state) => state.runCommand)
  return useMemo(
    () =>
      catalog.plugins.flatMap((plugin) => {
        if (!plugin.enabled || plugin.status === 'error' || plugin.status === 'pending-approval') return []
        return plugin.manifest.contributes.commands.map((command) => {
          const keybinding = plugin.manifest.contributes.keybindings.find((k) => k.command === command.command)
          return {
            id: `${plugin.id}:${command.command}`,
            // 清单里是 `%cmd.new%`,注册进 i18n 的是 `plugin.<id>.cmd.new`
            titleKey: `plugin.${plugin.id}.${command.title.slice(1, -1)}`,
            icon: normalizeMenuIcon(command.icon),
            ...(keybinding === undefined ? {} : { accelerator: keybinding.key }),
            pluginId: plugin.id,
            run: () => runCommand(plugin.id, command.command)
          } satisfies Command
        })
      }),
    [catalog, runCommand]
  )
}

/**
 * 按 id 去重并排序。
 *
 * ★ **内置优先**。同 id 时内置胜出 —— 插件注册一条 `builtin.openSettings`
 * 不该能顶掉真正的「打开设置」。清单侧已经挡了一道(命令 id 必须是插件自己
 * 声明过的),这里是第二道:两道各挡一件事,缺任何一道都还站得住,
 * 但缺了这一道就意味着「命令面板里的条目可以被冒名」。
 */
export function mergeCommands(builtin: readonly Command[], contributed: readonly Command[]): Command[] {
  const seen = new Set(builtin.map((command) => command.id))
  const out = [...builtin]
  for (const command of contributed) {
    if (seen.has(command.id)) continue
    seen.add(command.id)
    out.push(command)
  }
  return out
}
