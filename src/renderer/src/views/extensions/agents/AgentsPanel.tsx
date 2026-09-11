import { Bot } from 'lucide-react'
import type { ReactNode } from 'react'
import { PERMISSION_MODES, type PermissionMode } from '../../../../../shared/domain/permission'
import { Segmented } from '../../../components/ui/Segmented'
import { TextInput } from '../../../components/ui/TextInput'
import { useI18n } from '../../../i18n'
import { listAgents, onAgentsChanged, setAgentEnabled } from '../../../services/agents'
import { readField, readListField, setField, setListField, type Frontmatter } from '../markdown/frontmatter-form'
import { ResourcePanel, type PanelRow } from '../shared/ResourcePanel'

function AgentFields({ fm, set }: { fm: Frontmatter; set: (fm: Frontmatter) => void }): ReactNode {
  const { t } = useI18n()
  const mode = readField(fm, 'permissionMode')
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        {/* ★ 必填：缺了它 `agent/load.ts` 会把整条作废，用户存完会发现子代理消失了。 */}
        <span className="w-[92px] shrink-0 text-[12px] text-danger">{t('ext.field.description')}*</span>
        <TextInput
          value={readField(fm, 'description')}
          onChange={(v) => set(setField(fm, 'description', v))}
          size="sm"
          invalid={readField(fm, 'description').trim() === ''}
          placeholder={t('ext.field.agentDescriptionHint')}
          ariaLabel={t('ext.field.description')}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-[92px] shrink-0 text-[12px] text-fg-muted">{t('ext.field.tools')}</span>
        <TextInput
          value={readListField(fm, 'tools').join(', ')}
          onChange={(v) => set(setListField(fm, 'tools', v.split(',').map((s) => s.trim()).filter((s) => s !== '')))}
          size="sm"
          placeholder={t('ext.field.toolsHint')}
          ariaLabel={t('ext.field.tools')}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-[92px] shrink-0 text-[12px] text-fg-muted">{t('ext.field.model')}</span>
        <TextInput
          value={readField(fm, 'model')}
          onChange={(v) => set(setField(fm, 'model', v))}
          size="sm"
          placeholder={t('ext.field.modelHint')}
          ariaLabel={t('ext.field.model')}
        />
      </label>
      <div className="flex items-center gap-2">
        <span className="w-[92px] shrink-0 text-[12px] text-fg-muted">{t('ext.field.permissionMode')}</span>
        <Segmented<string>
          size="sm"
          value={mode === '' ? 'inherit' : mode}
          onChange={(v) => set(setField(fm, 'permissionMode', v === 'inherit' ? '' : v))}
          label={t('ext.field.permissionMode')}
          options={[
            { value: 'inherit', label: t('ext.field.inherit') },
            ...PERMISSION_MODES.map((m: PermissionMode) => ({ value: m, label: t(`permission.${m}`) }))
          ]}
        />
      </div>
    </div>
  )
}

export function AgentsPanel(): ReactNode {
  const { t } = useI18n()
  return (
    <ResourcePanel
      kind="agent"
      icon={<Bot size={26} />}
      emptyTitle={t('ext.agents.empty')}
      emptyHint={t('ext.agents.emptyHint')}
      load={async (workspaceId) =>
        (await listAgents(workspaceId)).map<PanelRow>((a) => ({
          name: a.name,
          description: a.description,
          scope: a.scope,
          enabled: a.enabled
        }))
      }
      setEnabled={setAgentEnabled}
      subscribe={onAgentsChanged}
      renderFields={(fm, set) => <AgentFields fm={fm} set={set} />}
      // 新建时就把 description 的位置占出来 —— 它是必填的，空着打开会直接标红。
      newFileDefaults={() => ({ frontmatter: { description: '' }, body: '' })}
    />
  )
}
