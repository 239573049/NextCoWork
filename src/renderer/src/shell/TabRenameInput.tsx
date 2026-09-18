/**
 * 标签上就地改名的输入框 —— 内外两层 Tab 条共用。
 *
 * 抄两份的代价很具体:提交 / 取消 / 选区 / 输入法这四件事各有一个容易踩空的
 * 细节(见下),两层各踩一半的话,「双击改名」在内层和外层会是两种手感。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { fileNameStem } from './tab-rename'

export function TabRenameInput({
  initial,
  ariaLabel,
  selectStem = false,
  onSubmit,
  onCancel,
  className
}: {
  initial: string
  ariaLabel: string
  /**
   * 默认选中**不含扩展名**的那一段(VS Code / Finder 的行为)。
   * 只有文件类标签给 true —— 会话标题里的点不是扩展名。
   */
  /**
   * 默认选区跳过扩展名(VS Code / Finder 行为)。只有**改盘上文件名**时才该开;
   * 会话标题、工作区名里的 `.` 不是扩展名,跳掉会让用户只选中半截。
   */
  selectStem?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
  className?: string
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  /** 提交与取消只许发生一次 —— Enter 之后紧跟的那次 blur 不该再提交一遍 */
  const settled = useRef(false)

  useEffect(() => {
    const input = ref.current
    if (input === null) return
    input.focus()
    if (selectStem) input.setSelectionRange(0, fileNameStem(initial).length)
    else input.select()
  }, [])

  const submit = (): void => {
    if (settled.current) return
    settled.current = true
    onSubmit(ref.current?.value ?? initial)
  }
  const cancel = (): void => {
    if (settled.current) return
    settled.current = true
    onCancel()
  }

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={initial}
      aria-label={ariaLabel}
      /*
        ★ `app-no-drag` 是外层 Tab 条的硬要求:那一条整个落在 Electron 自绘标题栏
        (`.app-drag`)里,漏掉的话按下去不是把光标放进输入框,而是拖整个窗口。
        内层不在拖动区,多这一个类无害。
      */
      className={cn(
        'app-no-drag selectable min-w-0 flex-1 rounded-[5px] bg-surface-field px-1',
        'text-inherit outline-none ring-1 ring-accent',
        className
      )}
      /*
        ★ 三个 stopPropagation 各挡一件事:
        - pointerdown:父级的拖动重排(`useDragReorder`)会吞掉选区拖拽;
        - click:父级的 `onActivate` 会在每次点击输入框时切走标签;
        - dblclick:否则在输入框里双击选词会再触发一次"进入编辑态"。
      */
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // ★ 中文输入法组字期间的回车是"确认候选词",不是提交
          if (e.nativeEvent.isComposing) return
          e.preventDefault()
          submit()
        } else if (e.key === 'Escape') {
          /*
            ★ 只 `preventDefault()`,**绝不 `stopPropagation()`**。React 18 把
            监听器挂在根容器上,合成事件的 stopPropagation 拦不住 document 级的
            原生监听 —— 而浮层关闭正挂在那里。于是在这里按 Esc 会「取消改名」
            **加上**「关掉整个浮层」。约定:document 级的 Escape 消费者一律先查
            `e.defaultPrevented`(同 `components/ui/TextInput.tsx`)。
          */
          e.preventDefault()
          cancel()
        }
      }}
    />
  )
}
