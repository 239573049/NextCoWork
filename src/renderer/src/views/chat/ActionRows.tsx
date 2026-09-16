/**
 * 交互卡里的「动作行」:一列可以按数字键点名、按 Enter 执行的行。
 *
 * ★ **它和 `RadioCards` 长得一样,但语义不同,所以没有合并。** 选项行点下去
 * 只是「选中」,答完再统一提交;动作行点下去**当场就执行**(批准计划、允许
 * 工具)。硬合成一个组件,这两件事会长得一模一样 —— 而它们一个可撤销、一个
 * 不可撤销。共用的只有视觉壳子(`OptionRow`),那部分在 `ui/ChoiceCards` 里。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { OptionRow, ROW_HIT, RowLead } from '../../components/ui/ChoiceCards'
import { isEditableTarget, isSelfHandlingButton, resolveRowKey } from './interaction-keys'

export interface ActionRowSpec {
  value: string
  label: string
  /** 行下面那句小字。用来把代价说出来(如「会把规则写进本机配置」)。 */
  description?: string
  icon?: ReactNode
  /** 这一行点下去不是立刻执行,而是就地展开一块输入区。 */
  expands?: boolean
}

export function ActionRows({
  rows,
  ariaLabel,
  disabled = false,
  onRun,
  onExpandedChange,
  renderExpanded
}: {
  rows: readonly ActionRowSpec[]
  ariaLabel: string
  disabled?: boolean
  /** 执行某一行。展开行是「写完之后」才走到这里。 */
  onRun: (value: string) => void
  /** 哪一行正展开着。卡片拿它来决定要不要收起被展开区顶替掉的那块预览。 */
  onExpandedChange?: (value: string | null) => void
  /** 展开行的内容。`collapse` 交给里面的「取消」用。 */
  renderExpanded?: (value: string, collapse: () => void) => ReactNode
}): ReactNode {
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  // 行数会变(展开编辑参数时「以后都允许」就撤走了),高亮不能停在一个
  // 已经不存在的下标上 —— 那样收起之后整列看不出 Enter 会落在哪。
  const current = active < rows.length ? active : 0

  // ★ 卡片出现时把焦点接过来 —— 否则数字键形同虚设,焦点常年在下面的输入框上。
  //   但**只在用户没在打字时接**:正写到一半被抢走焦点,比没有快捷键糟得多。
  useEffect(() => {
    if (isEditableTarget(document.activeElement)) return
    container.current?.focus({ preventScroll: true })
  }, [])

  function focusRow(index: number): void {
    setActive(index)
    buttons.current[index]?.focus({ preventScroll: true })
  }

  function changeExpanded(next: string | null): void {
    setExpanded(next)
    onExpandedChange?.(next)
  }

  function trigger(index: number): void {
    const row = rows[index]
    if (row === undefined || disabled) return
    if (row.expands === true) { changeExpanded(row.value); return }
    onRun(row.value)
  }

  return (
    <div
      ref={container}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      data-testid="interaction-rows"
      className="flex flex-col gap-1.5 outline-none"
      onKeyDown={(event) => {
        const action = resolveRowKey(event, {
          count: rows.length,
          active: current,
          inEditable: isEditableTarget(event.target),
          expanded: expanded !== null,
          onOtherButton: isSelfHandlingButton(event.target)
        })
        if (action === null) return
        event.preventDefault()
        // Enter 在展开态里是「把写好的这条发出去」,而不是执行高亮那一行。
        if (action.kind === 'run') {
          if (expanded === null) trigger(current)
          else onRun(expanded)
          return
        }
        if (action.kind === 'collapse') { changeExpanded(null); focusRow(current); return }
        focusRow(action.index)
      }}
    >
      {rows.map((row, index) => {
        const on = expanded === null ? index === current : expanded === row.value
        return (
          <OptionRow
            key={row.value}
            checked={on}
            disabled={disabled}
            expanded={expanded === row.value ? renderExpanded?.(row.value, () => { changeExpanded(null); focusRow(index) }) : undefined}
            trailing={on && expanded === null && row.expands !== true
              ? <ArrowRight aria-hidden size={14} className="text-fg-muted" />
              : undefined}
          >
            <button
              ref={(node) => { buttons.current[index] = node }}
              type="button"
              role="menuitem"
              disabled={disabled}
              data-testid="interaction-row"
              data-row-value={row.value}
              className={ROW_HIT}
              // 焦点跟着高亮走,但**悬停不动它** —— 鼠标随便停在哪儿就改掉
              // Enter 的落点,是最难查的那种误操作。
              onFocus={() => setActive(index)}
              onClick={() => trigger(index)}
            >
              <RowLead index={index} checked={on} kind="plain" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] leading-[1.5] text-fg">
                  {row.icon}
                  {row.label}
                </span>
                {row.description !== undefined && row.description !== '' && (
                  <span className="mt-0.5 block text-[12px] leading-[1.5] text-fg-muted">{row.description}</span>
                )}
              </span>
            </button>
          </OptionRow>
        )
      })}
    </div>
  )
}
