import { ChevronDown } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Menu, MenuItem, MenuLabel } from '../../components/ui/Menu'
import { cn } from '../../lib/cn'
import { useModelsStore } from '../../stores/models'
import { SettingGroup, SettingRow } from '../Row'
import type { SettingsPageProps } from '../props'

/**
 * ★ 已知缺口:`Menu` 是 `absolute` 且不 portal,而内容区是 `overflow-y-auto` ——
 * 下拉面板如果落在滚动区靠下的位置会被裁掉半截。所以这两行**刻意放在页面最上面**。
 * 真正的修法(向上翻转或 portal)不在这一步做,写在这里免得下次有人加行时踩到。
 */
export function ModelPage({ settings, patch }: SettingsPageProps): ReactNode {
  const models = useModelsStore((s) => s.models)
  const loaded = useModelsStore((s) => s.loaded)
  const load = useModelsStore((s) => s.load)
  const providerOf = useModelsStore((s) => s.providerOf)

  useEffect(() => {
    void load()
  }, [load])

  const picker = (value: string, onPick: (alias: string) => void, label: string): ReactNode => (
    <Menu
      label={label}
      align="end"
      width={280}
      triggerClassName="w-full"
      trigger={
        <span
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-[8px] border border-border',
            'bg-surface-field px-2.5 text-[13px]'
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate text-left', value === '' && 'text-fg-faint')}>
            {value === '' ? (loaded ? '跟随对话' : '加载中…') : value}
          </span>
          <ChevronDown size={14} className="shrink-0 text-icon" />
        </span>
      }
    >
      {(close) => (
        <>
          <MenuLabel>可用模型</MenuLabel>
          <MenuItem
            checked={value === ''}
            onSelect={() => {
              onPick('')
              close()
            }}
          >
            跟随对话
          </MenuItem>
          {models.map((m) => (
            <MenuItem
              key={`${m.providerId}:${m.alias}`}
              checked={value === m.alias}
              description={providerOf(m.alias)?.name}
              onSelect={() => {
                onPick(m.alias)
                close()
              }}
            >
              {m.alias}
            </MenuItem>
          ))}
          {loaded && models.length === 0 && (
            <MenuLabel>还没有配置上游供应商(步骤 4)</MenuLabel>
          )}
        </>
      )}
    </Menu>
  )

  return (
    <SettingGroup>
      <SettingRow
        title="默认模型"
        description="新对话的初值。和输入框上那颗模型药丸读的是同一份表(provider:listModels)。"
        wide
      >
        {picker(settings.defaultModel, (defaultModel) => patch({ defaultModel }), '默认模型')}
      </SettingRow>
      <SettingRow
        title="默认子代理模型"
        description="留空 = 子代理跟随主对话的模型。落点:步骤 11 的子代理池。"
        wide
        last
      >
        {picker(
          settings.subagent.model,
          (model) => patch({ subagent: { model } }),
          '默认子代理模型'
        )}
      </SettingRow>
    </SettingGroup>
  )
}
