import { cn } from '../../lib/cn'

/**
 * 纯受控文本框。**故意不含草稿逻辑** —— 两类调用点要的东西正好相反:
 *
 *   设置浮层的搜索框:逐键过滤,受控就是它想要的;
 *   代理地址 / 端口:  逐键写入等于每敲一个字符一次 IPC + 一次全窗口广播,
 *                      而且中间态(空串、只打了 `http://`)不该被存进设置。
 *
 * 所以草稿态在**外面**做(`settings/Row.tsx` 的 `TextFieldRow`、`NumberInput`),
 * 这一层只负责长相。把草稿塞进这里的话,搜索框就得为了绕开它而不用它。
 *
 * `bg-surface-field` 而不是 `bg-tint-hover`:深色下两者同值,浅色下不是 ——
 * 理由见 theme.css 里那个 token 的注释。
 * `.selectable` 是必须的:全局 `user-select: none`,输入框要自己 opt-in。
 */
export function TextInput({
  value,
  onChange,
  onCommit,
  onRevert,
  placeholder,
  icon,
  invalid = false,
  disabled = false,
  ariaLabel,
  size = 'md',
  inputMode,
  className,
  inputRef
}: {
  value: string
  onChange: (v: string) => void
  /** Enter 或失焦。搜索框不传 —— 它没有「提交」这个概念 */
  onCommit?: () => void
  /** Escape。不传时 Escape 交给上层(设置浮层用它关闭) */
  onRevert?: () => void
  placeholder?: string
  /** 左侧那颗图标(搜索框的放大镜) */
  icon?: React.ReactNode
  /** 端口越界这类:描红环,但**不阻止继续输入** */
  invalid?: boolean
  disabled?: boolean
  ariaLabel: string
  size?: 'sm' | 'md'
  inputMode?: 'text' | 'numeric' | 'url'
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
}): React.ReactNode {
  return (
    <div
      className={cn(
        'app-no-drag flex items-center gap-2 rounded-[8px] border transition-colors',
        'bg-surface-field',
        size === 'sm' ? 'h-7 px-2' : 'h-8 px-2.5',
        invalid ? 'border-danger' : 'border-border focus-within:border-accent',
        disabled && 'opacity-40',
        className
      )}
    >
      {icon !== undefined && <span className="shrink-0 text-fg-faint">{icon}</span>}
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit?.()
            e.currentTarget.blur()
          } else if (e.key === 'Escape' && onRevert !== undefined) {
            // ★ 用 preventDefault 宣告「这次 Escape 我消费了」,**不能用
            // stopPropagation**:React 18 把监听器挂在根容器上,合成事件的
            // stopPropagation 只影响 React 树内部,原生事件照样一路冒到
            // document —— 而设置浮层的关闭正是挂在 document 上的。
            // 于是在端口框里按 Escape 会「还原草稿」+「整个面板消失」。
            // 约定:document 级的 Escape 消费者一律先查 `e.defaultPrevented`。
            e.preventDefault()
            onRevert()
          }
        }}
        className={cn(
          'selectable min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none',
          'placeholder:text-fg-faint'
        )}
      />
    </div>
  )
}
