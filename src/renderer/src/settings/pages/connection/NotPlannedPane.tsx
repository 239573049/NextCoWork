/**
 * 连接器 / 插件 / 机器人对话 —— 参考图里有这三个子 Tab,方案里**没有**对应子系统。
 *
 * ★ **直说没有,不写「即将推出」。** 同 `StubPage.tsx` 的规矩,只是这里连一个
 * 步骤号都编不出来:那三块不在 §1–§14 的任何一步里。给个假进度条或者摆几条
 * 占位数据,下一个接手的人要读完整份方案才能确认那是假的 —— 而这一句话
 * 一秒钟就能核对。
 */
import { Blocks, Bot, Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState } from '../../../components/ui/EmptyState'

const REASON: Record<string, { icon: ReactNode; title: string; hint: string }> = {
  connector: {
    icon: <Plug size={26} />,
    title: '没有连接器',
    hint:
      '参考产品在这里放的是它自家的一批云服务接入。NextCoWork 是本地模式,' +
      '外部能力统一走 MCP —— 左边那一栏就是。'
  },
  plugin: {
    icon: <Blocks size={26} />,
    title: '没有插件系统',
    hint:
      '方案里没有第三方插件这一块。能扩展的两条路都在:MCP 接外部工具,' +
      '技能(设置 › 通用)改 Agent 的行为。'
  },
  bot: {
    icon: <Bot size={26} />,
    title: '没有机器人对话',
    hint:
      '参考产品用它把对话接到飞书 / 钉钉 / 微信这类 IM 上。方案里没有这一块,' +
      '也没有承载它的服务端。'
  }
}

export function NotPlannedPane({ sub }: { sub: string }): ReactNode {
  const r = REASON[sub]
  if (r === undefined) return null
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState icon={r.icon} title={r.title} hint={r.hint} />
    </div>
  )
}
