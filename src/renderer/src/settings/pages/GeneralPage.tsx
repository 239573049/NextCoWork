import { useEffect, useMemo, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  PERMISSION_MODES,
  type PermissionMode
} from '../../../../shared/agent/permission'
import type { ModelAlias, UpstreamProvider } from '../../../../shared/domain/provider'
import { Segmented } from '../../components/ui/Segmented'
import { Slider } from '../../components/ui/Slider'
import { Toggle } from '../../components/ui/Toggle'
import { Select } from '../../components/ui/Select'
import { ProviderModelMenu, type ProviderModelMenuRow } from '../../components/ProviderModelMenu'
import { cn } from '../../lib/cn'
import { useModelsStore } from '../../stores/models'
import {
  modelOptions,
  providerAliasOptions,
  roleModelChoice,
  selectableProviders
} from './model/enabled-models'
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
import { DefaultOpenTargetSelect } from './DefaultOpenTargetSelect'
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
        {/*
          需求：默认模型/默认子代理原来放在「模型」设置页,挤在供应商列表那条
          236px 窄列的 footer 里,和「来 Agent 页配权限/审核模型」不是同一次
          心智动作——用户得先记得"哦对了默认模型要去另一个页面改"。挪来这里后,
          跟下面的 AI 审核模型/目标判定模型同属「Agent 用哪个模型」这一类问题,
          放在同一屏。`entries`/供应商列表上的「默认」徽章原样留在模型设置页,
          那边展示的是库存视图,不受这次搬迁影响。

          ★ 这两行现在是 `SettingRow wide`,跟同屏的 AI 审核模型/目标判定模型
          用同一种控件外观(单个下拉触发器)——之前那版拆成「供应商」「模型」
          两个并排 `Select` 之后用户反馈还是不够贴合这一屏其余行的样子。
          `ProviderModelMenu` 复刻的是输入框模型选择器那套弹层交互(先选供应商
          再选模型、当前项打勾),理由和取舍写在该组件的文件头。
        */}
        <SettingRow title={t('models.default')} wide>
          <RoleModelPicker
            label={t('models.default')}
            models={models}
            providers={providers}
            loaded={loaded}
            model={settings.defaultModel}
            modelProviderId={settings.defaultModelProviderId}
            onChange={(model, modelProviderId) => {
              patch({ defaultModel: model, defaultModelProviderId: modelProviderId })
            }}
          />
        </SettingRow>
        <SettingRow title={t('models.defaultSubagent')} wide>
          <RoleModelPicker
            label={t('models.defaultSubagent')}
            models={models}
            providers={providers}
            loaded={loaded}
            model={settings.subagent.model}
            modelProviderId={settings.subagent.modelProviderId}
            onChange={(model, modelProviderId) => {
              patch({ subagent: { model, modelProviderId } })
            }}
          />
        </SettingRow>
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

      {/* 需求:文件树右键第一行「在 X 中打开」的 X 在这里选(见 `DefaultOpenTargetSelect` 文件头) */}
      <SettingGroup title={t('openWith.settingGroup')}>
        <SettingRow title={t('openWith.settingTitle')} description={t('openWith.settingHint')} wide last>
          <DefaultOpenTargetSelect
            value={settings.defaultOpenTarget}
            onChange={(defaultOpenTarget) => patch({ defaultOpenTarget })}
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

/**
 * 「默认模型」/「默认子代理」那一栏 —— **先供应商,再这一家的模型**。
 * 原本在 `model/ModelPage.tsx`,随这两项设置一起搬到这里(见 `sub === 'agent'`
 * 分支头部的需求注释)。
 *
 * ★ 触发器画成跟 `Select`(`components/ui/Select.tsx`)同款的按钮(高度/边框/
 * 字号都照抄),点开之后走的是 `ProviderModelMenu`——输入框模型选择器那套
 * 「先选供应商、进去再选模型、当前项打勾」的弹层交互,而不是原生 `<select>`。
 * 这一栏之前拆成两个并排 `Select`(供应商一个、模型一个),摆在这一屏其余
 * 单控件的行里明显不像原生设置,所以换成跟别的行一样「一个下拉触发器」。
 *
 * ★★ 两级的结果永远**成对**交给 `onChange`,调用方不需要(也不应该)自己拼:
 * 存的是 `(别名, 供应商)` 一对,而「A 家的别名 + B 家的锁」拼出来的候选集是空的,
 * 表现是下一次发送直接失败、错误还指着一个跟这次选择无关的供应商。
 *
 * ★★ 不用 `permissionReviewerModel`/`goalEvaluatorModel` 那种合并下拉
 * (`modelSelectionKey` + `modelOptions`)——理由在 `model/enabled-models.ts`
 * 那段 ★★ 注释:合并下拉只有一家提供某别名时不显示供应商名,而默认模型/默认
 * 子代理这两栏存的恰恰是 `(别名, 供应商)` 一对,「哪一家」是它的一半内容。
 * 触发器上的文案因此**总是**带供应商名(`别名 · 供应商`),不是只在别名冲突时才带。
 */
function RoleModelPickerComponent({
  label,
  models,
  providers,
  loaded,
  model,
  modelProviderId,
  onChange
}: {
  label: string
  models: readonly ModelAlias[]
  providers: readonly UpstreamProvider[]
  loaded: boolean
  model: string
  modelProviderId: string | undefined
  /** 别名与供应商**必须一起给**。`("", undefined)` = 跟随对话 */
  onChange: (model: string, modelProviderId: string | undefined) => void
}): ReactNode {
  const { t } = useI18n()
  const choice = roleModelChoice(models, providers, model, modelProviderId)
  const providerName = providers.find((p) => p.id === choice.providerId)?.name
  const triggerLabel =
    choice.alias === ''
      ? t('models.followConversation')
      : providerName === undefined
        ? choice.alias
        : `${choice.alias} · ${providerName}`
  const rows: ProviderModelMenuRow[] = useMemo(
    () =>
      selectableProviders(models, providers, choice.providerId).map((p) => {
        const aliasOptions = providerAliasOptions(models, p.id)
        return {
          id: p.id,
          label: p.name,
          description: t('chat.availableModels', { count: aliasOptions.length }),
          selected: p.id === choice.providerId,
          models: aliasOptions.map((o) => ({
            value: o.value,
            label: o.label,
            selected: p.id === choice.providerId && o.value === choice.alias
          }))
        }
      }),
    [models, providers, choice.providerId, choice.alias, t]
  )

  return (
    <ProviderModelMenu
      trigger={
        <>
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronDown size={12} className="shrink-0 text-fg-faint" />
        </>
      }
      // 视觉上照抄 `Select` 的触发器类名,这一屏其余控件才不会显得它是外来的。
      triggerClassName={cn(
        'group flex h-7 w-full items-center gap-1.5 rounded-[7px] border border-border',
        'bg-surface-field px-2 text-left text-[11.5px] text-fg outline-none',
        'transition-[background-color,border-color,box-shadow] duration-150',
        'hover:bg-tint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/15'
      )}
      className="w-full"
      align="start"
      width={280}
      ariaLabel={label}
      menuLabel={t('chat.selectProvider')}
      loaded={loaded}
      loadingLabel={t('common.loading')}
      emptyLabel={t('chat.noModelsConfigured')}
      rows={rows}
      topItem={{
        label: t('models.followConversation'),
        selected: choice.providerId === '',
        onSelect: () => onChange('', undefined)
      }}
      onSelectModel={(providerId, alias) => onChange(alias, providerId)}
    />
  )
}

// Keep the component reference explicit at module scope. This avoids stale
// development hot-update modules resolving the JSX symbol before a function
// declaration is reinstalled.
const RoleModelPicker = RoleModelPickerComponent

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
