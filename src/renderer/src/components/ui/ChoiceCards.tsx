import { Check } from 'lucide-react'
import { Checkbox as CheckboxPrimitive, RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface ChoiceOption {
  value: string
  label: string
  /** 选项下面那行小字。给了才占第二行,没给就是单行。 */
  description?: string
}

/**
 * 「一组可选项」的两种形态:单选(`RadioCards`)与多选(`CheckboxCards`)。
 *
 * ★ **两者共用同一副卡片外壳,只有指示器不同** —— 分成两个文件写的话,某一天
 * 改选中态的配色就会改漏一个,而这两组卡片在同一张问答卡里上下相邻,漏掉的那个
 * 一眼就能看出来。差异被收在 `indicator` 一个参数里,壳子只有一份。
 *
 * 无障碍与键盘导航交给 Radix:单选组的方向键漫游、`aria-checked`、
 * 空格切换都在原语里,自己用 `<div onClick>` 拼是拼不出来的。
 */
const CARD = [
  'app-no-drag group flex w-full cursor-pointer items-start gap-2.5 rounded-[8px] border',
  'px-2.5 py-2 text-left outline-none transition-[background-color,border-color] duration-150',
  'focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-default disabled:opacity-40'
].join(' ')

/** 选中 = 描边转 accent + 底色进「槽」。和 `Select` 的展开态同一套语言。 */
const CARD_STATE = 'border-border bg-transparent hover:bg-tint data-[state=checked]:border-accent data-[state=checked]:bg-tint'

function OptionBody({ option }: { option: ChoiceOption }): ReactNode {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] leading-[1.5] text-fg">{option.label}</span>
      {option.description !== undefined && option.description !== '' && (
        <span className="mt-0.5 block text-[12px] leading-[1.5] text-fg-muted">{option.description}</span>
      )}
    </span>
  )
}

export function RadioCards({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  className
}: {
  value: string
  options: readonly ChoiceOption[]
  onValueChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn('flex flex-col gap-1.5', className)}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item key={option.value} value={option.value} className={cn(CARD, CARD_STATE)}>
          <span
            className={cn(
              'mt-[3px] flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-pill border',
              'border-fg-faint transition-colors group-data-[state=checked]:border-accent'
            )}
          >
            <RadioGroupPrimitive.Indicator className="h-[7px] w-[7px] rounded-pill bg-accent" />
          </span>
          <OptionBody option={option} />
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

export function CheckboxCards({
  values,
  options,
  onToggle,
  ariaLabel,
  disabled = false,
  className
}: {
  values: readonly string[]
  options: readonly ChoiceOption[]
  /** 只报「哪一项被点了」,合进已选集合是调用方的事 —— 那里才知道要不要保序 */
  onToggle: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    // Radix 没有 CheckboxGroup —— 分组语义靠这层 role 补,少了它读屏只会念出
    // 一串互不相干的复选框,听不出它们属于同一道题。
    <div role="group" aria-label={ariaLabel} className={cn('flex flex-col gap-1.5', className)}>
      {options.map((option) => {
        const checked = values.includes(option.value)
        return (
          <CheckboxPrimitive.Root
            key={option.value}
            checked={checked}
            disabled={disabled}
            onCheckedChange={() => onToggle(option.value)}
            className={cn(CARD, CARD_STATE)}
          >
            <span
              className={cn(
                'mt-[3px] flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] border',
                'border-fg-faint transition-colors',
                checked && 'border-accent bg-accent'
              )}
            >
              <CheckboxPrimitive.Indicator>
                <Check aria-hidden size={10} strokeWidth={3} className="text-accent-fg" />
              </CheckboxPrimitive.Indicator>
            </span>
            <OptionBody option={option} />
          </CheckboxPrimitive.Root>
        )
      })}
    </div>
  )
}
