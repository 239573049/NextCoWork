/**
 * 状态栏 —— 插件挂读数的那一条。
 *
 * ## 之前完全不存在
 *
 * 窗口底部原来什么都没有。做这一条不是为了「看起来更完整」,而是因为
 * 插件需要一个**常驻、不抢注意力**的位置报告持续状态(「正在同步」
 * 「3 个未提交」)。没有它的话,插件只能用通知,而通知是一次性的、
 * 会打断人 —— 一个每 30 秒弹一次的插件会让人卸载它。
 *
 * ## 三条约束
 *
 * 1. **文案是 key,不是字符串**。状态栏是全应用最显眼的一块常驻文字,
 *    让插件往这里塞任意字符串等于给它一块广告位,而且切语言不会变。
 * 2. **每插件最多 3 格**(在主进程侧卡住,见 `manager.ts`)。
 * 3. **不占内容区的流**。它是 `shrink-0` 的一条,高度固定 22px ——
 *    一个内容变长的插件格子不该把上面的编辑器挤扁。
 */
import type { ReactNode } from 'react'
import type { PluginStatusBarItem } from '../../../shared/plugin/state'
import { useI18n, type TranslationKey } from '../i18n'
import { cn } from '../lib/cn'
import { usePluginsStore } from '../stores/plugins'

export function StatusBar(): ReactNode {
  const { t } = useI18n()
  const catalog = usePluginsStore((state) => state.catalog)
  const runCommand = usePluginsStore((state) => state.runCommand)

  const items: PluginStatusBarItem[] = catalog.plugins
    .filter((plugin) => plugin.enabled && plugin.status !== 'error' && plugin.status !== 'pending-approval')
    .flatMap((plugin) => plugin.statusBar)

  // ★ 一格都没有时**整条不渲染**,不是渲染一条空的。留一条空条等于永久占掉
  //   22px 的内容高度,换来的是一个完全没有信息的横条。
  if (items.length === 0) return null

  return (
    <footer className="flex h-[22px] shrink-0 items-center gap-1 border-t border-hairline bg-surface px-2">
      {items.map((item) => {
        const label = t(item.textKey as TranslationKey)
        const clickable = item.command !== undefined
        return (
          <button
            key={`${item.pluginId}:${item.id}`}
            type="button"
            disabled={!clickable}
            title={item.tooltipKey === undefined ? undefined : t(item.tooltipKey as TranslationKey)}
            onClick={() => {
              if (item.command === undefined) return
              void runCommand(item.pluginId, item.command)
            }}
            className={cn(
              'app-no-drag max-w-[220px] truncate rounded-[5px] px-1.5 text-[11px] text-fg-muted',
              clickable ? 'hover:bg-tint-hover hover:text-fg' : 'cursor-default'
            )}
          >
            {label}
          </button>
        )
      })}
    </footer>
  )
}
