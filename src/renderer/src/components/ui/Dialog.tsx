/**
 * 模态弹窗 —— 参考图那个「添加 MCP 服务器」用的就是它。
 *
 * ★ **四条约束照抄 `SettingsOverlay.tsx`,一条都不能少。** 它们各自对应一个
 * 已经踩过的坑,而这个弹窗和设置浮层处在完全相同的位置(全窗覆盖、压着自绘
 * 标题栏、里面装着草稿态输入框):
 *
 * 1. **根节点 `app-no-drag`。** 顶部那条 34px 标题栏是
 *    `-webkit-app-region: drag`,OS 吞掉该区域里所有 pointer 事件 ——
 *    不加的话弹窗上半部分点不动,一按住整个窗口跟着鼠标跑。
 * 2. **`z-100`。** 见 theme.css 末尾的 z 轴约定:50 是面板内的下拉,100 是模态。
 * 3. **Esc 前先看 `e.defaultPrevented`。** 弹窗里有 `Segmented`,将来还会有
 *    别的自关闭组件;不查这个的话,一次 Esc 会把弹窗和设置浮层一起关掉。
 *    ★ 而且这里 `stopPropagation` 也是必须的 —— 设置浮层在 `document` 上
 *    也挂着一个 Esc 监听,两个都跑的话弹窗关了、浮层也没了。
 * 4. **点遮罩关闭绑 `click` 不绑 `pointerdown`。** 输入框是草稿态、靠失焦提交:
 *    pointerdown 会在 blur 之前就把面板卸掉,用户刚打的那行没了。
 *
 * ## 唯一一条**反着来**的:这里必须 portal
 *
 * `SettingsOverlay` 的文件头写着「不 portal」,那条在这里不适用,因为两者
 * 挂的位置不同。浮层挂在应用根上,`fixed` 就是相对视口的;而这个弹窗是从
 * **设置内容区里**渲染出来的,那个容器带着 `.fade-bottom`
 * (`mask-image`,见 theme.css)——**带 mask 的元素会成为 `position: fixed`
 * 后代的包含块**。于是 `fixed inset-0` 不再是「铺满窗口」,而是「铺满那块
 * 滚动区」,再被它的 `overflow-y-auto` 裁一刀:弹窗被压进内容区、标题随内容
 * 滚没、底边还带着一道渐隐。光加 `z-100` 救不回来 —— 那是层叠问题,这是**几何**问题。
 *
 * 挂到 `document.body` 之后:
 * - **层级**:portal 节点排在 `#root` 之后,同为 `z-100` 时后来者在上,稳定压住设置浮层;
 * - **焦点**:`useFocusTrap` 的 Tab 监听挂在各自的面板元素上(不是 document),
 *   弹窗在浮层的 DOM 之外,两个陷阱因此互不干扰;
 * - **事件**:React 的合成事件仍沿 **React 树**冒泡,调用点原有的 onClick 之类照旧。
 *
 * ★ **类型选择器请用 `Segmented`,不要用 `Menu`** —— `ModelPage.tsx:9-13`
 * 记着 Menu 在滚动区里会被裁掉。这句话写在这里,是因为下一个往弹窗里加
 * 下拉框的人先看到的是这个文件。
 */
import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { IconButton } from './IconButton'
import { useFocusTrap } from './useFocusTrap'
import { useI18n } from '../../i18n'

export function Dialog({
  title,
  description,
  open,
  onClose,
  footer,
  width = 520,
  children
}: {
  title: string
  /** 标题下那行小字。参考图的弹窗有,不给就不占位 */
  description?: string
  open: boolean
  onClose: () => void
  /** 右下角那排按钮。由调用方给 —— 「保存」的可用性只有表单自己知道 */
  footer?: ReactNode
  width?: number
  children: ReactNode
}): ReactNode {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLDivElement>(null)

  useFocusTrap(panelRef, open, firstRef)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      // ★ 拦住,别让设置浮层那个 document 级监听也跑一遍(约束 3)
      e.stopPropagation()
      onClose()
    }
    // 捕获阶段:document 上那个监听是冒泡阶段的,捕获阶段先到,
    // stopPropagation 才拦得住它
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="app-no-drag fixed inset-0 z-100 flex items-center justify-center p-[10px]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-scrim/35 backdrop-blur-[2px]" onClick={onClose} />

      <div
        ref={panelRef}
        tabIndex={-1}
        style={{ width }}
        className={cn(
          'relative flex max-h-full w-full flex-col overflow-hidden bg-surface',
          'rounded-panel shadow-2xl shadow-black/40 outline-none'
        )}
      >
        <div ref={firstRef} tabIndex={-1} className="flex shrink-0 items-start gap-2 px-5 pt-4 outline-none">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] text-fg">{title}</div>
            {description !== undefined && (
              <div className="mt-0.5 text-[12px] text-fg-faint">{description}</div>
            )}
          </div>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>

        {/* 内容自己滚 —— 弹窗整体高度受 max-h-full 限制,而表单可以很长 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer !== undefined && (
          <div className="flex shrink-0 items-center justify-end gap-2 px-5 pb-4">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  )
}
