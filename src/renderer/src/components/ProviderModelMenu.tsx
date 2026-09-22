/**
 * 供应商 → 模型的两级弹层菜单:先选供应商,选中后在旁边弹出这一家的模型子菜单。
 *
 * 从 `views/chat/Composer.tsx` 原来的 `ModelPicker`/`ModelSubmenu` 抽出来——
 * 设置页「通用 → Agent」的默认模型/默认子代理现在要一模一样的交互(先选供应商、
 * 再选模型、当前项打勾),而子菜单这套定位逻辑(贴着被悬停的那一行弹出、
 * 视口边界内会翻到另一侧、跟着 resize/scroll 重新量高度)不是能随手抄一遍的东西——
 * 抄错一处的症状是「面板飞到屏幕外」或「面板不跟手」,两个都不报错、只能肉眼看见。
 * 两处需求一致,所以抽成共享组件,而不是复制一份改改字段名。
 *
 * ★★ 不用 `components/ui/Menu.tsx` 自带的（唯一一层）面板:那个组件假设自己的
 * 面板挂在**触发器**上,而这里的第二级要挂在**被悬停的那一行按钮**上,且第二级
 * 开着时点第二级不能被外层判定成「点了外面」从而关闭——所以第二级是手写的
 * `createPortal` + 外层 `Menu` 的 `containsTarget`,这一点和 Composer 原来的
 * 做法一致,没有改逻辑,只是搬了地方。
 *
 * ★ 这个组件不知道「供应商 / 模型该怎么过滤、怎么排序」——`rows` 由调用方算好
 * 再传进来。聊天输入框和设置页对「同一个别名能不能显示成待选项」的规则并不一样
 * (设置页要在供应商已停用时仍然把它留在列表里方便改,输入框不需要),
 * 把这条规则拉平进共享层只会逼一边迁就另一边的隐藏假设。
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { Menu, MenuItem, MenuLabel } from './ui/Menu'

export interface ProviderModelMenuModelOption {
  value: string
  label: string
  selected: boolean
}

export interface ProviderModelMenuRow {
  id: string
  label: string
  /** 副标题,比如「N 个可用模型」 */
  description?: string
  selected: boolean
  models: readonly ProviderModelMenuModelOption[]
}

export function ProviderModelMenu({
  trigger,
  triggerClassName,
  className,
  ariaLabel,
  menuLabel,
  menuIcon,
  align = 'start',
  width = 300,
  loaded = true,
  loadingLabel,
  emptyLabel,
  rows,
  topItem,
  onSelectModel
}: {
  /** 触发按钮的内容;按钮本身由内部的 `Menu` 渲染。 */
  trigger: ReactNode
  triggerClassName?: string
  /**
   * 转发给内部 `Menu` 的 `className`(外层包裹 `div`)。composer 的药丸要
   * `shrink`,设置页的行内下拉要撑满控件列——**默认值只满足前者**,后者必须
   * 显式传 `'w-full'`,不然按钮会缩成内容宽度,在 318px 的控件列里贴左。
   */
  className?: string
  /**
   * 触发器的无障碍 label。不传就用 `menuLabel`——composer 里只有一个模型
   * 选择器,两者相同没关系;设置页同一屏有「默认模型」「默认子代理」两个
   * 实例,共用 `menuLabel`(可见的面板标题文案)会让读屏读出同一句话,
   * 分不清哪个是哪个,所以那边必须显式传这一项。
   */
  ariaLabel?: string
  /** 顶层面板标题(比如「选择模型提供商」),渲染在面板里,人人都看得见。 */
  menuLabel: string
  menuIcon?: ReactNode
  align?: 'start' | 'end'
  width?: number
  /** 数据还没到齐时只显示 `loadingLabel`,不渲染供应商列表。 */
  loaded?: boolean
  loadingLabel?: string
  /** `rows` 为空(没有可选供应商)时显示的提示。 */
  emptyLabel?: string
  rows: readonly ProviderModelMenuRow[]
  /**
   * 顶层列表最前面单独一项,不进入第二级(比如「跟随对话」)。
   * 只有需要「允许不钉死具体模型」这个状态的调用方才传。
   */
  topItem?: { label: string; selected: boolean; onSelect: () => void }
  onSelectModel: (providerId: string, alias: string) => void
}): ReactNode {
  const [openRowId, setOpenRowId] = useState<string | null>(null)
  const [submenuAnchor, setSubmenuAnchor] = useState<HTMLButtonElement | null>(null)
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const submenuRef = useRef<HTMLDivElement>(null)
  const closeMenuRef = useRef<() => void>(() => {})

  const openRow = (id: string): void => {
    setOpenRowId(id)
    setSubmenuAnchor(rowRefs.current[id] ?? null)
  }
  const openRowData = rows.find((r) => r.id === openRowId)

  return (
    <>
      <Menu
        label={ariaLabel ?? menuLabel}
        width={width}
        align={align}
        className={className ?? 'min-w-0'}
        triggerClassName={triggerClassName}
        trigger={trigger}
        onOpenChange={(open) => {
          if (!open) {
            setOpenRowId(null)
            setSubmenuAnchor(null)
          }
        }}
        containsTarget={(target) => submenuRef.current?.contains(target) ?? false}
      >
        {(close) => {
          closeMenuRef.current = close
          return (
            <>
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  {menuIcon}
                  {menuLabel}
                </span>
              </MenuLabel>
              {topItem !== undefined && (
                <MenuItem
                  checked={topItem.selected}
                  onSelect={() => {
                    topItem.onSelect()
                    close()
                  }}
                >
                  {topItem.label}
                </MenuItem>
              )}
              {!loaded ? (
                <MenuLabel>{loadingLabel}</MenuLabel>
              ) : rows.length === 0 ? (
                <MenuLabel>{emptyLabel}</MenuLabel>
              ) : (
                rows.map((row) => (
                  <MenuItem
                    key={row.id}
                    checked={row.selected}
                    description={row.description}
                    buttonRef={(node) => {
                      rowRefs.current[row.id] = node
                    }}
                    onHover={() => openRow(row.id)}
                    onSelect={() => openRow(row.id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      <ChevronRight size={13} className="text-fg-faint" />
                    </span>
                  </MenuItem>
                ))
              )}
            </>
          )
        }}
      </Menu>
      {submenuAnchor !== null && openRowData !== undefined && typeof document !== 'undefined'
        ? createPortal(
            <ModelSubmenu
              anchor={submenuAnchor}
              panelRef={(node) => {
                submenuRef.current = node
              }}
              title={openRowData.label}
              models={openRowData.models}
              onSelect={(alias) => {
                onSelectModel(openRowData.id, alias)
                closeMenuRef.current()
                setSubmenuAnchor(null)
                setOpenRowId(null)
              }}
            />,
            document.body
          )
        : null}
    </>
  )
}

function ModelSubmenu({
  anchor,
  panelRef,
  title,
  models,
  onSelect
}: {
  anchor: HTMLElement
  panelRef: (node: HTMLDivElement | null) => void
  title: string
  models: readonly ProviderModelMenuModelOption[]
  onSelect: (alias: string) => void
}): ReactNode {
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const width = 300
  const panelNode = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const panelHeight = Math.min(
        panelNode.current?.scrollHeight ?? 0,
        Math.max(0, viewportHeight - 16)
      )
      const preferredLeft =
        rect.right + 6 + width <= viewportWidth ? rect.right + 6 : rect.left - width - 6
      const left = Math.max(8, Math.min(preferredLeft, viewportWidth - width - 8))
      // 与触发项顶部对齐；下方空间不足时向上推，确保整个弹层留在视口内。
      const top = Math.max(8, Math.min(rect.top, viewportHeight - panelHeight - 8))
      setPosition({ top, left })
    }
    measure()
    const resizeObserver = new ResizeObserver(measure)
    if (panelNode.current !== null) resizeObserver.observe(panelNode.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchor, models.length])

  return (
    <div
      ref={(node) => {
        panelNode.current = node
        panelRef(node)
      }}
      role="menu"
      style={{
        width,
        top: position.top,
        left: position.left,
        maxHeight: 'calc(100vh - 16px)'
      }}
      className="app-no-drag scroll-thin fixed z-[60] overflow-y-auto rounded-card border border-border bg-surface-raised p-1 shadow-2xl shadow-black/40"
    >
      <MenuLabel>{title}</MenuLabel>
      {models.map((m) => (
        <MenuItem key={m.value} checked={m.selected} onSelect={() => onSelect(m.value)}>
          {m.label}
        </MenuItem>
      ))}
    </div>
  )
}
