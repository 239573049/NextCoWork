/**
 * 设置浮层导航的图标。和 `nav.ts` 分开,是为了让 `nav.ts` 连同 `matchRows`
 * 保持零 React 依赖 —— vitest 跑在 node 环境里(照 `shell/icons.ts` 的先例)。
 *
 * 「每日回顾」刻意复用 `FEATURE_ICON.review`:侧边栏那一项和这一页是同一个东西
 * 的两个位置,图标各写各的迟早会漂成两个。
 */
import {
  Cpu,
  Database,
  Info,
  Plug,
  SlidersHorizontal,
  Sparkles,
  User,
  Wallet,
  type LucideIcon
} from 'lucide-react'
import { FEATURE_ICON } from '../shell/icons'
import type { SettingsPageId } from './nav'

export const SETTINGS_ICON: Record<SettingsPageId, LucideIcon> = {
  account: User,
  wallet: Wallet,
  general: SlidersHorizontal,
  preference: Sparkles,
  model: Cpu,
  review: FEATURE_ICON.review,
  connection: Plug,
  computer: FEATURE_ICON.browser,
  data: Database,
  about: Info
}
