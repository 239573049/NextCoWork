import type { ReactNode } from 'react'
import type { ThemePreference } from '../../../../shared/domain/settings'
import { Segmented } from '../../components/ui/Segmented'
import { prettyAccelerator } from '../../lib/accelerator'
import { SettingGroup, SettingRow } from '../Row'
import type { SettingsPageProps } from '../props'

export function PreferencePage({ settings, patch }: SettingsPageProps): ReactNode {
  return (
    <>
      <SettingGroup>
        <SettingRow
          title="主题"
          description="「跟随系统」交给主进程的 nativeTheme 解析,解析结果通过 theme:changed 广播到每个窗口。"
          wide
          last
        >
          <Segmented<ThemePreference>
            label="主题"
            value={settings.theme}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' }
            ]}
            onChange={(theme) => patch({ theme })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="快捷键">
        <SettingRow
          title="打开设置"
          description="装在渲染层的 document 上,不是 macOS 应用菜单 —— 所以窗口没聚焦时它不响应,也不会出现在菜单栏里。要补的话得连一整套应用菜单模板一起补(见 AppShell 里那段注释)。"
          last
        >
          <kbd className="rounded-[6px] bg-tint px-2 py-1 font-sans text-[12px] text-fg">
            {prettyAccelerator('CmdOrCtrl+,')}
          </kbd>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
