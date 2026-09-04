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

export function GeneralPage({ settings, sub, patch }: SettingsPageProps): ReactNode {
  if (sub === 'agent') {
    return (
      <SettingGroup>
        <SettingRow
          title="默认权限档位"
          description={
            <>
              {PERMISSION_MODE_HINT[settings.defaultPermissionMode]}。这是<b className="font-normal text-fg">新</b>
              工作区的初值;已经存在的工作区用它自己那一份(输入框左下角那颗)。
            </>
          }
          wide
          last
        >
          <Segmented<PermissionMode>
            label="默认权限档位"
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
      <SettingGroup title="Agent 资源调度">
        <SettingRow
          title="单对话子代理上限"
          description="一段对话里最多同时派出几个子代理(方案 §4.9)。落点:步骤 11 的子代理池。"
          wide
        >
          <SliderField
            value={settings.subagent.perSessionLimit}
            min={1}
            max={10}
            recommended={4}
            label="单对话子代理上限"
            onCommit={(perSessionLimit) => patch({ subagent: { perSessionLimit } })}
          />
        </SettingRow>
        <SettingRow
          title="子代理并发上限"
          description="全应用的子代理池大小。0 = 不允许派子代理。"
          wide
          last
        >
          <SliderField
            value={settings.subagent.globalLimit}
            min={0}
            max={10}
            recommended={4}
            label="子代理并发上限"
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
          title="界面语言"
          description="本版只有中文文案,选了先存着不生效。"
          wide
          last
        >
          <Segmented<AppLocale>
            label="界面语言"
            value={settings.locale}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' }
            ]}
            onChange={(locale) => patch({ locale })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="提示音">
        <SettingRow
          title="任务完成提示音"
          description={
            <>
              一轮回复跑完时响一声。 <LandsAt>落点:步骤 5 的 InteractionKind</LandsAt>
            </>
          }
        >
          <Toggle
            label="任务完成提示音"
            checked={settings.notifications.taskComplete}
            onChange={(taskComplete) => patch({ notifications: { taskComplete } })}
          />
        </SettingRow>
        <SettingRow title="权限审批提示音" description="有工具操作等着你批准时响一声。">
          <Toggle
            label="权限审批提示音"
            checked={settings.notifications.permissionApproval}
            onChange={(permissionApproval) => patch({ notifications: { permissionApproval } })}
          />
        </SettingRow>
        <SettingRow title="计划审批提示音" description="计划模式产出待确认的计划时响一声。" last>
          <Toggle
            label="计划审批提示音"
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
  return (
    <div className="w-full">
      <div className="mb-2 flex items-baseline justify-between text-[11.5px]">
        <span className="text-fg">当前 {value}</span>
        <span className="text-fg-faint">推荐 {recommended}</span>
      </div>
      <Slider value={value} min={min} max={max} ariaLabel={label} onCommit={onCommit} />
    </div>
  )
}
