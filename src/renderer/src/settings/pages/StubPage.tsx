import type { ReactNode } from 'react'
import { EmptyState } from '../../components/ui/EmptyState'
import { SETTINGS_ICON } from '../icons'
import type { SettingsPageId } from '../nav'

/**
 * 照参考图铺出来、但本版没有内容的四页。
 *
 * ★ **直说是被砍掉的 / 排在第几步,不写「即将推出」。** 账户 / 钱包 / 每日回顾
 * 在方案 §10 是明确砍掉的(侧边栏左下角之所以从「账户」换成设置入口就是因为
 * 这个),写成「即将推出」是在骗自己;电脑操作是步骤 9,那有个真实的编号可写。
 */
const REASON: Partial<Record<SettingsPageId, { title: string; hint: string }>> = {
  account: {
    title: '没有账户体系',
    hint: '方案 §10 砍掉了账户 / 云同步那一整块 —— NextCoWork 是本地模式,数据只存在这台电脑上。'
  },
  wallet: {
    title: '没有钱包',
    hint: '同上,商业化面整块砍掉。模型用量与计费由你自己配置的上游供应商负责(设置 › 模型)。'
  },
  review: {
    title: '每日回顾本版不做',
    hint: '和侧边栏那一项是同一句话 —— 见 views/registry.tsx。'
  },
  computer: {
    title: '电脑操作',
    hint: '步骤 9:真实文件系统工具与计算机操作。现在只有入口,没有开关可调。'
  }
}

export function StubPage({ page }: { page: SettingsPageId }): ReactNode {
  const Icon = SETTINGS_ICON[page]
  const r = REASON[page]
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState
        icon={<Icon size={26} />}
        title={r?.title ?? '本版不做'}
        hint={r?.hint}
      />
    </div>
  )
}
