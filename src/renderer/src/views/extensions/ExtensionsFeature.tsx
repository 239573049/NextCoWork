/**
 * 扩展面板 —— 技能 / 命令 / 子代理 / 钩子四类资源的统一入口。
 *
 * ★ 为什么这四个在一起、而不是散进设置页:它们在磁盘上是**同构**的 ——
 * 同样的 `<appData>/xxx/` + `<workspaceRoot>/.next-cowork/xxx/` 两层扫描、
 * 同样的 frontmatter、同样的「项目覆盖全局」。而设置页装的是开关型配置
 * (选一个值、拨一下就生效),塞不下一个带列表和编辑器的资源管理器。
 *
 * ★ 这一层只负责**外壳**:52px 的 header(返回 + 标题 + 四路 Tab)和分发。
 * 每个 Tab 的工具条归各自的 Panel 自己画 —— 四类资源的操作差别很大
 * (Skill 要装包、命令要新建文件、钩子要试运行),提到这里只会变成一堆
 * 互相不相干的条件渲染。
 */
import { ArrowLeft } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IconButton } from '../../components/ui/IconButton'
import { Segmented } from '../../components/ui/Segmented'
import { useI18n } from '../../i18n'
import { SkillsFeature } from '../skills/SkillsFeature'
import { AgentsPanel } from './agents/AgentsPanel'
import { CommandsPanel } from './commands/CommandsPanel'
import { HooksPanel } from './hooks/HooksPanel'

type ExtensionTab = 'skills' | 'commands' | 'agents' | 'hooks'

export function ExtensionsFeature({ onClose }: { onClose?: () => void }): ReactNode {
  const { t } = useI18n()
  const [tab, setTab] = useState<ExtensionTab>('skills')

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="app-drag flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline px-4">
        <IconButton label={t('ext.back')} size={28} width={40} onClick={onClose} className="rounded-pill bg-tint">
          <ArrowLeft size={15} />
        </IconButton>
        <h1 className="text-[14px] font-medium text-fg">{t('ext.title')}</h1>
        <Segmented<ExtensionTab>
          className="ml-3 app-no-drag"
          size="sm"
          value={tab}
          onChange={setTab}
          label={t('ext.title')}
          options={[
            { value: 'skills', label: t('ext.tab.skills') },
            { value: 'commands', label: t('ext.tab.commands') },
            { value: 'agents', label: t('ext.tab.agents') },
            { value: 'hooks', label: t('ext.tab.hooks') }
          ]}
        />
      </header>

      {/*
        ★ Skills 走 `chromeless`:它自带一个和上面这条一模一样的 header(返回 + 标题),
        嵌进来会变成两条。右侧那三颗按钮(刷新 / 作用域 / 安装)是 Skill 专属的,
        留在它自己那条工具条里。
      */}
      {tab === 'skills' ? (
        <SkillsFeature chromeless />
      ) : tab === 'commands' ? (
        <CommandsPanel />
      ) : tab === 'agents' ? (
        <AgentsPanel />
      ) : (
        <HooksPanel />
      )}
    </div>
  )
}
