import { Check, ChevronDown } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
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
 *
 * 动效借自 beUI 的 Select（https://beui.dev/components/motion/select，MIT）：
 * 面板从触发器下方「分离」出来、选项逐项带一点模糊浮现、箭头用带回弹的曲线转半圈。
 * ★ 只借**外观与动效**，没有换成它的实现 —— 它的面板是 `absolute` 定位在字段内部，
 * 会被设置页里带 `overflow-hidden` 的卡片裁掉；这里保留 Radix 的 portal + 碰撞检测。
 * 关闭时 Radix 直接卸载面板，所以只有入场动画，没有退场。
 */

const LIST: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.025, delayChildren: 0.04 } },
};
const ITEM: Variants = {
  hidden: { opacity: 0, y: -4, filter: "blur(3px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } },
};
export function Select({
  value,
  options,
  onValueChange,
  ariaLabel,
  className,
  disabled = false,
  inModal = false,
  onOpenChange,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  /**
   * 放在 `Dialog` 里时必须打开。
   *
   * ★★ theme.css 那条「模态自己建层叠上下文,内部的 z-50 天然在遮罩之上」
   * 对这个组件**不成立** —— Radix 把浮层 portal 到 `document.body`,于是它和
   * `Dialog`(同样 portal 到 body、z-100)成了同级兄弟,z-60 直接被压在弹窗背后。
   * 症状不是「样式错位」而是「点了没反应」:菜单开了,只是看不见。
   */
  inModal?: boolean;
  /**
   * 打开/关闭回调。★ 对话模型选择器用它做「打开时校正」(见 `useChatModelGuard`);
   * 可选,缺省不影响任何现有调用方的行为。
   */
  onOpenChange?: (open: boolean) => void;
}): ReactNode {
  // Radix 把空串保留给“尚未选择”的内部状态；设置里的“跟随对话”恰好以空串持久化。
  // 为这个选项映射一个仅在组件内部使用、且不会和调用方值冲突的值。
  let emptyValue = "__nextcowork_empty_select_value__";
  while (options.some((option) => option.value === emptyValue)) {
    emptyValue = `_${emptyValue}`;
  }
  const radixValue = value === "" ? emptyValue : value;
  const reduce = useReducedMotion() ?? false;

  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(nextValue) =>
        onValueChange(nextValue === emptyValue ? "" : nextValue)
      }
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "app-no-drag group flex h-7 w-full items-center gap-1.5 rounded-[9px] border border-border",
          "bg-surface-field px-2.5 text-left text-[11.5px] text-fg outline-none",
          "transition-[background-color,border-color,box-shadow,border-radius] duration-150",
          "hover:bg-tint focus-visible:border-fg-faint focus-visible:ring-2 focus-visible:ring-fg-faint/15",
          // 展开时朝向面板的那条边先收平,面板再分离出去 —— 两者像是一整块被捏开
          "data-[state=open]:border-fg-faint data-[state=open]:bg-tint data-[state=open]:rounded-b-[4px]",
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
        <SelectPrimitive.Icon className="shrink-0 text-fg-faint transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-data-[state=open]:rotate-180 motion-reduce:transition-none">
          <ChevronDown aria-hidden size={12} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={cn(
            "app-no-drag max-h-[min(240px,var(--radix-select-content-available-height))]",
            inModal ? "z-[150]" : "z-[60]",
            "w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[12px] border border-border",
            "bg-surface-raised p-1 shadow-2xl shadow-black/40 outline-none",
            // 入场:从触发器那一侧轻轻展开。transform-origin 用 Radix 算好的锚点,翻到上方时自动跟着翻
            "origin-[var(--radix-select-content-transform-origin)]",
            "data-[state=open]:animate-[select-unfold_0.22s_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none",
          )}
        >
          <SelectPrimitive.Viewport className="scroll-thin overflow-y-auto">
            <motion.div
              variants={reduce ? undefined : LIST}
              initial={reduce ? false : "hidden"}
              animate="show"
            >
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value === "" ? emptyValue : option.value}
                  asChild
                >
                  <motion.div
                    variants={reduce ? undefined : ITEM}
                    className={cn(
                      "relative flex min-h-7 cursor-default select-none items-center rounded-[8px] py-1 pr-6 pl-2",
                      "text-[11.5px] text-fg-muted outline-none transition-colors",
                      "data-[highlighted]:bg-tint-hover data-[highlighted]:text-fg",
                      "data-[state=checked]:bg-tint data-[state=checked]:text-fg",
                    )}
                  >
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center text-accent">
                      <Check aria-hidden size={11} />
                    </SelectPrimitive.ItemIndicator>
                  </motion.div>
                </SelectPrimitive.Item>
              ))}
            </motion.div>
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
