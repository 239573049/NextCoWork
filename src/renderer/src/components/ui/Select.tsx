import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type SelectOption = {
  value: string;
  label: string;
};

/**
 * 应用内的紧凑下拉选择器。
 *
 * Radix 负责弹层、焦点管理和键盘导航；这里仅固定应用的视觉与 `app-no-drag`
 * 约束，避免设置浮层里的原生 select 露出系统控件样式。
 */
export function Select({
  value,
  options,
  onValueChange,
  ariaLabel,
  className,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}): ReactNode {
  // Radix 把空串保留给“尚未选择”的内部状态；设置里的“跟随对话”恰好以空串持久化。
  // 为这个选项映射一个仅在组件内部使用、且不会和调用方值冲突的值。
  let emptyValue = "__nextcowork_empty_select_value__";
  while (options.some((option) => option.value === emptyValue)) {
    emptyValue = `_${emptyValue}`;
  }
  const radixValue = value === "" ? emptyValue : value;

  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(nextValue) =>
        onValueChange(nextValue === emptyValue ? "" : nextValue)
      }
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "app-no-drag group flex h-7 w-full items-center gap-1.5 rounded-[7px] border border-border",
          "bg-surface-field px-2 text-left text-[11.5px] text-fg outline-none",
          "transition-[background-color,border-color,box-shadow] duration-150",
          "hover:bg-tint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/15",
          "data-[state=open]:border-accent data-[state=open]:bg-tint",
          className,
        )}
      >
        {/*
          ★ 截断的类名必须挂在**外面这个 span** 上,不能挂在 `Select.Value` 上。
          Radix 的 `SelectValue` 把 `className` 和 `style` 解构出去之后就再也没用上
          (`react-select/dist/index.mjs`:`const { …, className, style, … } = props`,
          随后只展开剩下的 `valueProps`,并把 style 写死成 `pointerEvents: 'none'`)——
          写在它身上的样式是**静默失效**的,不报错、不警告,只是长模型名会换行,
          把 h-7 的触发器撑出两三行。
        */}
        <span className="min-w-0 flex-1 truncate">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon className="shrink-0 text-fg-faint transition-transform duration-150 group-data-[state=open]:rotate-180">
          <ChevronDown aria-hidden size={12} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "app-no-drag z-[60] max-h-[min(240px,var(--radix-select-content-available-height))]",
            "w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card border border-border",
            "bg-surface-raised p-1 shadow-2xl shadow-black/40 outline-none",
          )}
        >
          <SelectPrimitive.Viewport className="scroll-thin overflow-y-auto">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value === "" ? emptyValue : option.value}
                className={cn(
                  "relative flex min-h-7 cursor-default select-none items-center rounded-[6px] py-1 pr-6 pl-2",
                  "text-[11.5px] text-fg outline-none",
                  "data-[highlighted]:bg-tint-hover data-[highlighted]:text-fg",
                )}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center text-accent">
                  <Check aria-hidden size={11} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
