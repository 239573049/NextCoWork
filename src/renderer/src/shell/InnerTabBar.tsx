/**
 * 内层 Tab 条 —— **同一个组件供三条 Tab 条使用**:主区那条、底部面板那条、
 * 右侧面板那条。
 *
 * ★ 底部不是「终端面板」,右侧也不是「文件面板」,它们各是一条内层 Tab 条
 * (见 shared/domain/tab.ts 的 `InnerTabBase.pane`)。参考实现里三处的 `+` 菜单
 * 是同一套东西的三个子集,右侧那颗 `+` 的 tooltip 甚至直接写着「添加右侧工作台标签」。
 * 所以差异全被收进 `menu` 和 `trailing` 两个参数,而不是抄三份组件 ——
 * 抄的代价是:三条 Tab 条的悬停态、关闭按钮、拖动手感会慢慢长歪。
 *
 * 形状和外层**故意不一样**:外层是浏览器式舌头(和内容面板连成一片),
 * 内层是**药丸**(激活的那颗底色 `tint`:新版参考实现深色量到 #2b2e2d,
 * 比 canvas #1e2020 **亮**,是凸出来的;浅色反过来是凹下去的,见 `theme.css` §4)。
 * 两层 Tab 长得一样的话,「这个 Tab 属于哪一层」就只能靠位置猜。
 *
 * 这一条不在 `.app-drag` 区里,所以不需要逐个 `.app-no-drag` ——
 * 但拖动重排用的是同一个 hook,行为和外层一致。
 */
import { ChevronDown, Plus, X } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import type { InnerTab, InnerTabKind, InnerTabMenuItem } from '../../../shared/domain/tab'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../components/ui/Menu'
import { prettyAccelerator } from '../lib/accelerator'
import { cn } from '../lib/cn'
import { INNER_TAB_ICON } from './icons'
import { useDragReorder } from './useDragReorder'

export function InnerTabBar({
  tabs,
  activeId,
  runningSessionIds,
  menu,
  trailing,
  className,
  onActivate,
  onClose,
  onMove,
  onOpen
}: {
  tabs: readonly InnerTab[]
  activeId: string | null
  runningSessionIds: ReadonlySet<string>
  /** `+` 菜单的内容。主区与底部各有一份常量,见 shared/domain/tab.ts */
  menu: readonly InnerTabMenuItem[]
  /** 条右端那个按钮:主区是「全部标签页」,底部是「关闭面板」 */
  trailing?: ReactNode
  className?: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** 下标是**本条内**的下标 —— 两条 Tab 条共用一张表,见 reorderInPane */
  onMove: (from: number, to: number) => void
  onOpen: (kind: InnerTabKind) => void
}): ReactNode {
  const { dragging, onPointerDown, styleFor } = useDragReorder(onMove)

  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center gap-1 border-b border-hairline px-2',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {tabs.map((tab, i) => {
          const active = tab.id === activeId
          const running = tab.kind === 'chat' && runningSessionIds.has(tab.ref.sessionId)
          const Icon = INNER_TAB_ICON[tab.kind]
          return (
            <div
              key={tab.id}
              style={styleFor(i)}
              onPointerDown={(e) => onPointerDown(e, i)}
              onClick={() => onActivate(tab.id)}
              role="tab"
              aria-selected={active}
              title={tab.title}
              className={cn(
                'group flex h-7 max-w-[190px] min-w-0 shrink-0 items-center gap-1.5 rounded-[8px]',
                'pr-1 pl-2.5 text-[12.5px] select-none',
                !dragging && 'transition-[transform,background-color]',
                active ? 'bg-tint text-fg' : 'text-fg-muted hover:bg-tint/50 hover:text-fg'
              )}
            >
              <Icon size={13} className="shrink-0 text-fg-faint" />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {running && <span className="size-1.5 shrink-0 rounded-pill bg-accent" />}
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                className={cn(
                  'flex size-[17px] shrink-0 items-center justify-center rounded-[5px]',
                  'text-fg-faint opacity-0 transition-opacity group-hover:opacity-100',
                  'hover:bg-tint-strong hover:text-fg focus-visible:opacity-100'
                )}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}

        <Menu
          label="新建标签页"
          width={230}
          trigger={<Plus size={15} />}
          triggerClassName="flex size-7 items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
        >
          {(close) => (
            <>
              {menu.map((item) => (
                <Fragment key={item.kind}>
                  {/* 分隔是**数据**(见 INNER_TAB_MENU),不是渲染时的 `i === 3` ——
                      底部那条菜单多了「文件预览」一项,按下标算分隔就错位了 */}
                  {item.separatorBefore === true && <MenuSeparator />}
                  <MenuItem
                    icon={(() => {
                      const Icon = INNER_TAB_ICON[item.kind]
                      return <Icon size={14} />
                    })()}
                    accelerator={prettyAccelerator(item.accelerator)}
                    onSelect={() => {
                      onOpen(item.kind)
                      close()
                    }}
                  >
                    {item.label}
                  </MenuItem>
                </Fragment>
              ))}
            </>
          )}
        </Menu>
      </div>

      {trailing}
    </div>
  )
}

/**
 * 主区那条 Tab 条**最右端**的 `⌄`(参考截图 2 里就在条的尽头,和 `+` 分列两端)。
 *
 * 它不是装饰。Tab 是 `max-w-[190px]` 的药丸且 `shrink-0`,开到七八个就会被推出
 * 可视区 —— 那时候这颗菜单是唯一还能切过去的入口。所以它列的是**本条的全部 Tab**,
 * 不是「最近打开的文件」之类另一份数据:一旦两者能不一致,这颗按钮就没用了。
 *
 * `align="end"` 是必须的:它贴着条的右边,菜单往左展开才不会溢出窗口。
 */
export function AllTabsMenu({
  tabs,
  activeId,
  onActivate
}: {
  tabs: readonly InnerTab[]
  activeId: string | null
  onActivate: (id: string) => void
}): ReactNode {
  return (
    <Menu
      label="全部标签页"
      width={240}
      align="end"
      trigger={<ChevronDown size={15} />}
      triggerClassName="flex size-[26px] items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
    >
      {(close) => (
        <>
          {tabs.length === 0 && <MenuLabel>没有标签页</MenuLabel>}
          {tabs.map((tab) => {
            const Icon = INNER_TAB_ICON[tab.kind]
            return (
              <MenuItem
                key={tab.id}
                icon={<Icon size={14} />}
                // 三态里只用两态:`checked` 给 undefined 的话勾位不占地方,
                // 激活项一勾整列就横向跳一下
                checked={tab.id === activeId}
                onSelect={() => {
                  onActivate(tab.id)
                  close()
                }}
              >
                {tab.title}
              </MenuItem>
            )
          })}
        </>
      )}
    </Menu>
  )
}
