import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 条件类名 + Tailwind 冲突消解。后写的赢 —— 组件才能接受外部覆盖。 */
export function cn(...parts: ClassValue[]): string {
  return twMerge(clsx(parts))
}
