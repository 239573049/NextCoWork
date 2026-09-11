import { TerminalSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { TextInput } from '../../../components/ui/TextInput'
import { useI18n } from '../../../i18n'
import { listAllCommands, onCommandsChanged, setCommandEnabled } from '../../../services/commands'
import { readField, setField, type Frontmatter } from '../markdown/frontmatter-form'
import { ResourcePanel, type PanelRow } from '../shared/ResourcePanel'

/** 命令的 frontmatter 只有两个字段，正文才是主体。 */
function CommandFields({ fm, set }: { fm: Frontmatter; set: (fm: Frontmatter) => void }): ReactNode {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <span className="w-[92px] shrink-0 text-[12px] text-fg-muted">{t('ext.field.description')}</span>
        <TextInput
          value={readField(fm, 'description')}
          onChange={(v) => set(setField(fm, 'description', v))}
          size="sm"
          placeholder={t('ext.field.descriptionHint')}
          ariaLabel={t('ext.field.description')}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-[92px] shrink-0 text-[12px] text-fg-muted">{t('ext.field.argumentHint')}</span>
        <TextInput
          value={readField(fm, 'argument-hint')}
          onChange={(v) => set(setField(fm, 'argument-hint', v))}
          size="sm"
          placeholder="<path>"
          ariaLabel={t('ext.field.argumentHint')}
        />
      </label>
    </div>
  )
}

export function CommandsPanel(): ReactNode {
  const { t } = useI18n()
  return (
    <ResourcePanel
      kind="command"
      icon={<TerminalSquare size={26} />}
      emptyTitle={t('ext.commands.empty')}
      emptyHint={t('ext.commands.emptyHint')}
      load={async (workspaceId) =>
        (await listAllCommands(workspaceId)).map<PanelRow>((c) => ({
          name: c.name,
          description: c.description,
          scope: c.scope,
          enabled: c.enabled,
          ...(c.argumentHint !== undefined ? { suffix: c.argumentHint } : {})
        }))
      }
      setEnabled={setCommandEnabled}
      subscribe={onCommandsChanged}
      renderFields={(fm, set) => <CommandFields fm={fm} set={set} />}
      newFileDefaults={() => ({ frontmatter: {}, body: '' })}
    />
  )
}
