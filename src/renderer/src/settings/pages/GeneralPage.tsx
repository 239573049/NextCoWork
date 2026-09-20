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
import {
  MODEL_PROPOSED_GOALS,
  MAX_OUTPUT_TOKENS_BOUNDS,
  isModelProposedGoals,
  isShellPreference,
  shellPreferencesForPlatform,
  type ShellPreference
} from '../../../../shared/domain/settings'
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../../../shared/agent/run-request'
import { DraftInput } from '../DraftInput'
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
    /*
      ★ 目标判定模型和审核模型存的是**同一种东西**(别名 + 供应商一对),所以候选也
        同一张表。空的含义在这里是「跟随本轮对话的模型」,不是「未配置」—— 判定器
        本来就有个天然的落点(这一轮自己那个模型),而审核模型那边没有,空着只能
        退回人工审批。
    */
    const goalEvaluatorOptions = [
      { value: '', label: t('models.followConversation') },
      ...modelOptions(models.filter((m) => m.enabled !== false), providers)
    ]
    // Shell 名称不翻译；值不在本平台表里时回到自动选择。
    const shellChoices = shellPreferencesForPlatform(window.nextcowork.platform)
    const shell: ShellPreference = shellChoices.includes(settings.shell) ? settings.shell : 'system'
    const shellOptions = shellChoices.map((value) => ({
      value,
      label: value === 'system' ? t('general.shellSystem') : SHELL_LABELS[value]
    }))
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
        <SettingRow
          title={t('settings.goal.evaluatorModel')}
          description={t('settings.goal.evaluatorModelHint')}
          wide
        >
          <Select
            value={modelSelectionKey(settings.goalEvaluatorModelProviderId, settings.goalEvaluatorModel)}
            options={goalEvaluatorOptions}
            ariaLabel={t('settings.goal.evaluatorModel')}
            onValueChange={(key) => {
              const { alias, modelProviderId } = parseModelSelectionKey(key)
              patch({ goalEvaluatorModel: alias, goalEvaluatorModelProviderId: modelProviderId })
            }}
          />
        </SettingRow>
        <SettingRow title={t('settings.goal.modelProposedGoals')} wide>
          <Select
            value={settings.modelProposedGoals}
            options={MODEL_PROPOSED_GOALS.map((value) => ({
              value,
              label: t(
                `settings.goal.modelProposedGoals.${value}` as
                  | 'settings.goal.modelProposedGoals.auto'
                  | 'settings.goal.modelProposedGoals.alwaysAsk'
                  | 'settings.goal.modelProposedGoals.disabled'
              )
            }))}
            ariaLabel={t('settings.goal.modelProposedGoals')}
            onValueChange={(value) => {
              // 三档是**枚举**,认不出来的值一个都不许落库 —— 见 `isModelProposedGoals`
              if (!isModelProposedGoals(value)) return
              patch({ modelProposedGoals: value })
            }}
          />
        </SettingRow>
        <SettingRow title={t('general.contextManagement')} description={t('general.contextManagementHint')}>
          <Toggle label={t('general.contextManagement')} checked={settings.contextManagement.experimentalMode}
            onChange={(experimentalMode) => patch({ contextManagement: { experimentalMode } })} />
        </SettingRow>
        <SettingRow title={t('general.autoCompact')} description={t('general.autoCompactHint')}>
          <Toggle label={t('general.autoCompact')} checked={settings.contextManagement.autoCompact}
            onChange={(autoCompact) => patch({ contextManagement: { autoCompact } })} />
        </SettingRow>
        <SettingRow
          title={t('general.maxOutputTokens')}
          description={t('general.maxOutputTokensHint', {
            min: MAX_OUTPUT_TOKENS_BOUNDS.min,
            max: MAX_OUTPUT_TOKENS_BOUNDS.max,
            fallback: DEFAULT_MAX_OUTPUT_TOKENS
          })}
        >
          <MaxOutputTokensInput
            value={settings.maxOutputTokens}
            onCommit={(maxOutputTokens) => patch({ maxOutputTokens })}
          />
        </SettingRow>
        <SettingRow
          title={t('general.shell')}
          description={t('general.shellHint')}
          wide
          last
        >
          <Select
            value={shell}
            options={shellOptions}
            inModal
            ariaLabel={t('general.shell')}
            onValueChange={(value) => {
              if (!isShellPreference(value) || !shellChoices.includes(value)) return
              patch({ shell: value })
            }}
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

/** Shell 名称保持原样；自动选择的文案由 i18n 提供。 */
const SHELL_LABELS: Record<Exclude<ShellPreference, 'system'>, string> = {
  cmd: 'CMD',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell 7 (pwsh)',
  zsh: 'Zsh',
  bash: 'Bash',
  fish: 'Fish',
  sh: 'sh'
}

/**
 * 最大输出 Token 的输入框。
 *
 * 需求:区间外的输入**不提交、原样还原**,和网络页的超时输入框同一套做法 ——
 * 主进程 `mergeSettings` 那侧也会再拦一次,两道都在是故意的:界面这道让用户
 * 当场看见自己打的值没被接受,不然他会以为存进去了,然后困惑于请求里还是旧额度。
 */
function MaxOutputTokensInput({
  value,
  onCommit
}: {
  value: number
  onCommit: (tokens: number) => void
}): ReactNode {
  const { t } = useI18n()
  return (
    <div className="w-[160px]">
      <DraftInput
        value={String(value)}
        disabled={false}
        ariaLabel={t('general.maxOutputTokens')}
        placeholder={String(DEFAULT_MAX_OUTPUT_TOKENS)}
        onCommit={() => {
          /* 提交在 transform 里做 —— 那边才有解析后的数字 */
        }}
        transform={(draft) => {
          const n = Number(draft.trim())
          if (
            !Number.isInteger(n) ||
            n < MAX_OUTPUT_TOKENS_BOUNDS.min ||
            n > MAX_OUTPUT_TOKENS_BOUNDS.max
          ) {
            return null
          }
          if (n !== value) onCommit(n)
          return String(n)
        }}
      />
    </div>
  )
}

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
