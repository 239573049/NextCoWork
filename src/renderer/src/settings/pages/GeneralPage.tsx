import { useEffect, type ReactNode } from 'react'
import {
  PERMISSION_MODES,
  type PermissionMode
} from '../../../../shared/agent/permission'
import { Segmented } from '../../components/ui/Segmented'
import { Slider } from '../../components/ui/Slider'
import { Toggle } from '../../components/ui/Toggle'
import { Select } from '../../components/ui/Select'
import { useModelsStore } from '../../stores/models'
import { modelOptions } from './model/enabled-models'
import {
  modelSelectionKey,
  parseModelSelectionKey
} from '../../../../shared/domain/model-selection'
import { LandsAt, SettingGroup, SettingRow } from '../Row'
import type { SettingsPageProps } from '../props'
import { useI18n } from '../../i18n'

export function GeneralPage({ settings, sub, patch }: SettingsPageProps): ReactNode {
  const { t } = useI18n()
  const models = useModelsStore((s) => s.models)
  const providers = useModelsStore((s) => s.providers)
  const loaded = useModelsStore((s) => s.loaded)
  const load = useModelsStore((s) => s.load)
  useEffect(() => {
    if (sub === 'agent' && !loaded) void load()
  }, [sub, loaded, load])
  if (sub === 'agent') {
    // 一条绑定一个选项 —— 同一别名挂在多家上时,「用哪一家审核」是用户要选的东西
    const reviewerOptions = [
      { value: '', label: t('general.permissionReviewerModelEmpty') },
      ...modelOptions(models.filter((m) => m.enabled !== false), providers)
    ]
      return (
        <SettingGroup>
        <SettingRow
          title={t('general.defaultPermission')}
          description={
            <>
              {t('general.defaultPermissionHint', {
                hint: t(`permission.${settings.defaultPermissionMode}` as 'permission.ask' | 'permission.auto' | 'permission.full')
              })}
            </>
          }
          wide
        >
          <Segmented<PermissionMode>
            label={t('general.defaultPermission')}
            value={settings.defaultPermissionMode}
            options={PERMISSION_MODES.map((m) => ({ value: m, label: t(`permission.${m}` as 'permission.ask' | 'permission.auto' | 'permission.full') }))}
            onChange={(defaultPermissionMode) => patch({ defaultPermissionMode })}
          />
        </SettingRow>
        <SettingRow
          title={t('general.permissionReviewerModel')}
          description={t('general.permissionReviewerModelHint')}
          wide
          last
        >
          <Select
            value={modelSelectionKey(settings.permissionReviewerModelProviderId, settings.permissionReviewerModel)}
            options={reviewerOptions}
            ariaLabel={t('general.permissionReviewerModel')}
            onValueChange={(key) => {
              const { alias, modelProviderId } = parseModelSelectionKey(key)
              patch({ permissionReviewerModel: alias, permissionReviewerModelProviderId: modelProviderId })
            }}
          />
        </SettingRow>
        <SettingRow title={t('general.contextManagement')} description={t('general.contextManagementHint')}>
          <Toggle label={t('general.contextManagement')} checked={settings.contextManagement.experimentalMode}
            onChange={(experimentalMode) => patch({ contextManagement: { experimentalMode } })} />
        </SettingRow>
        <SettingRow title={t('general.autoCompact')} description={t('general.autoCompactHint')} last>
          <Toggle label={t('general.autoCompact')} checked={settings.contextManagement.autoCompact}
            onChange={(autoCompact) => patch({ contextManagement: { autoCompact } })} />
        </SettingRow>
      </SettingGroup>
    )
  }

  if (sub === 'task') {
    return (
      <SettingGroup title={t('general.agentResources')}>
        <SettingRow
          title={t('general.perSessionSubagents')}
          description={t('general.perSessionSubagentsHint')}
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
          description={t('general.globalSubagentsHint')}
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
