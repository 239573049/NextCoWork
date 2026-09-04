import type { ReactNode } from 'react'
import {
  PERMISSION_MODES,
  PERMISSION_MODE_HINT,
  PERMISSION_MODE_LABEL,
  type PermissionMode
} from '../../../../shared/agent/permission'
import { Segmented } from '../../components/ui/Segmented'
import { Slider } from '../../components/ui/Slider'
import { Toggle } from '../../components/ui/Toggle'
import { LandsAt, SettingGroup, SettingRow } from '../Row'
import type { SettingsPageProps } from '../props'
import { useI18n } from '../../i18n'

export function GeneralPage({ settings, sub, patch }: SettingsPageProps): ReactNode {
  const { t } = useI18n()
  if (sub === 'agent') {
    return (
      <SettingGroup>
        <SettingRow
          title={t('general.defaultPermission')}
          description={
            <>
              {PERMISSION_MODE_HINT[settings.defaultPermissionMode]}。这是<b className="font-normal text-fg">{t('general.new')}</b>
              工作区的初值;已经存在的工作区用它自己那一份(输入框左下角那颗)。
            </>
          }
          wide
          last
        >
          <Segmented<PermissionMode>
            label={t('general.defaultPermission')}
            value={settings.defaultPermissionMode}
            options={PERMISSION_MODES.map((m) => ({ value: m, label: PERMISSION_MODE_LABEL[m] }))}
            onChange={(defaultPermissionMode) => patch({ defaultPermissionMode })}
          />
        </SettingRow>
      </SettingGroup>
    )
  }

  if (sub === 'task') {
    return (
      <SettingGroup title={t('general.agentResources')}>
        <SettingRow
          title={t('general.perSessionSubagents')}
          description="一段对话里最多同时派出几个子代理(方案 §4.9)。落点:步骤 11 的子代理池。"
          wide
        >
          <SliderField
            value={settings.subagent.perSessionLimit}
            min={1}
            max={10}
            recommended={4}
            label={t('general.perSessionSubagents')}
            onCommit={(perSessionLimit) => patch({ subagent: { perSessionLimit } })}
          />
        </SettingRow>
        <SettingRow
          title={t('general.globalSubagents')}
          description="全应用的子代理池大小。0 = 不允许派子代理。"
          wide
          last
        >
          <SliderField
            value={settings.subagent.globalLimit}
            min={0}
            max={10}
            recommended={4}
            label={t('general.globalSubagents')}
            onCommit={(globalLimit) => patch({ subagent: { globalLimit } })}
          />
        </SettingRow>
      </SettingGroup>
    )
  }

  return (
    <>
      <SettingGroup>
        <SettingRow
          title={t('settings.language')}
          description={t('settings.languageHint')}
          wide
          last
        >
          <Segmented<AppLocale>
            label={t('settings.language')}
            value={settings.locale}
            options={[
              { value: 'zh-CN', label: t('settings.simplifiedChinese') },
              { value: 'en-US', label: t('settings.english') }
            ]}
            onChange={(locale) => patch({ locale })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.sounds')}>
        <SettingRow
          title={t('settings.taskCompleteSound')}
          description={
            <>
              {t('settings.taskCompleteSoundHint')} <LandsAt>InteractionKind</LandsAt>
            </>
          }
        >
          <Toggle
            label={t('settings.taskCompleteSound')}
            checked={settings.notifications.taskComplete}
            onChange={(taskComplete) => patch({ notifications: { taskComplete } })}
          />
        </SettingRow>
        <SettingRow title={t('settings.permissionSound')} description={t('settings.permissionSoundHint')}>
          <Toggle
            label={t('settings.permissionSound')}
            checked={settings.notifications.permissionApproval}
            onChange={(permissionApproval) => patch({ notifications: { permissionApproval } })}
          />
        </SettingRow>
        <SettingRow title={t('settings.planSound')} description={t('settings.planSoundHint')} last>
          <Toggle
            label={t('settings.planSound')}
            checked={settings.notifications.planApproval}
            onChange={(planApproval) => patch({ notifications: { planApproval } })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

type AppLocale = 'zh-CN' | 'en-US'

/**
 * 滑杆 + 上方那行「当前 N · 推荐 M」—— 参考图 c44ef6d3 里就是这个形状。
 * 没有这行字的话,离散滑杆上根本读不出自己停在几。
 */
function SliderField({
  value,
  min,
  max,
  recommended,
  label,
  onCommit
}: {
  value: number
  min: number
  max: number
  recommended: number
  label: string
  onCommit: (v: number) => void
}): ReactNode {
  const { t } = useI18n()
  return (
    <div className="w-full">
      <div className="mb-2 flex items-baseline justify-between text-[11.5px]">
        <span className="text-fg">{t('settings.current', { value })}</span>
        <span className="text-fg-faint">{t('settings.recommended', { value: recommended })}</span>
      </div>
      <Slider value={value} min={min} max={max} ariaLabel={label} onCommit={onCommit} />
    </div>
  )
}
