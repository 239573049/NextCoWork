/**
 * 子代理 Tab。
 *
 * ★ 不再用 `ResourcePanel`:那一套的新建是「先弹框问名字和作用域」,而子代理的
 *   名字和作用域已经在它自己的结构化表单里 —— 再问一遍是多一道没意义的门,而且
 *   问完还不能改。共用的只剩列表那半边(`ResourceListPane`),命令那条路径一个字没动。
 *
 * ★ 存/删/建这三段和 `ResourcePanel` 里同形(含「新建那份 revision 是空串,
 *   传 undefined 走新建分支」这条),唯一多出来的是**改名 / 换作用域**:
 *   那在磁盘上是两个文件,所以要**先写新的、再删旧的**。
 */
import { Bot } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { MarkdownResourceFile } from '../../../../../shared/domain/markdown-resource'
import { useI18n } from '../../../i18n'
import { listAgents, onAgentsChanged, setAgentEnabled } from '../../../services/agents'
import { deleteResource, getResource, saveResource } from '../../../services/resources'
import { useWindowStore } from '../../../stores/window'
import { ResourceListPane } from '../shared/ResourceListPane'
import type { PanelRow } from '../shared/ResourcePanel'
import { AgentEditor, type AgentSavePayload } from './AgentEditor'
import { agentColorHex } from './agent-form'

export function AgentsPanel(): ReactNode {
  const { t } = useI18n()
  const workspaceId = useWindowStore((s) => s.activeWorkspaceId)
  const [rows, setRows] = useState<PanelRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<MarkdownResourceFile | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    void listAgents(workspaceId ?? undefined)
      .then((agents) =>
        setRows(agents.map<PanelRow>((a) => ({
          name: a.name,
          description: a.description,
          scope: a.scope,
          enabled: a.enabled,
          ...(agentColorHex(a.color) === undefined ? {} : { color: agentColorHex(a.color) })
        })))
      )
      .catch(() => setError(t('ext.error.loadFailed')))
  }, [workspaceId, t])

  useEffect(() => {
    refresh()
    return onAgentsChanged(refresh)
  }, [refresh])

  const open = (scope: 'global' | 'project', name: string): void => {
    setError(null)
    void getResource('agent', scope, name, workspaceId ?? undefined)
      .then(setEditing)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const create = (): void => {
    setError(null)
    /*
      ★ 先在内存里造一份「还没落盘」的文件,revision 留空。不先写一个空文件再打开,
      是因为用户可能填一半就走了 —— 那样磁盘上会留下一个半成品,而子代理的半成品
      会立刻被 `Task` 工具看见。
    */
    setEditing({
      kind: 'agent',
      scope: workspaceId === null ? 'global' : 'project',
      name: '',
      path: '',
      /*
        ★ 新建的默认档位是**完全访问**,而不是「继承」。省掉这个键的含义是
        「跟父代理同档」,可子代理是被 `Task` 派出去自己跑完一整段活的 —— 父代理
        在 ask 档时,它每动一次文件都要弹一次框,而弹框问的是用户看不见上下文的
        那一步,结果就是一路点「允许」。要收紧的人在表单里改一下就是了,
        但默认值得让它先能干活。
      */
      frontmatter: { permissionMode: 'full' },
      body: '',
      skipped: [],
      revision: ''
    })
  }

  const save = (payload: AgentSavePayload): void => {
    const current = editing
    if (current === null) return
    const isNew = current.revision === ''
    const moved = !isNew && (payload.name !== current.name || payload.scope !== current.scope)
    setSaving(true)
    setError(null)
    void saveResource({
      kind: 'agent',
      scope: payload.scope,
      name: payload.name,
      ...(workspaceId === null ? {} : { workspaceId }),
      frontmatter: payload.frontmatter,
      body: payload.body,
      /*
        ★ 改名 / 换作用域时也传 undefined:目标是一个**还不存在**的文件,带着旧文件的
        revision 去比对必然对不上。而 `writeResourceFile` 在 revision 缺席时会拒绝
        覆盖已有文件,所以「新建」这条分支本身就挡住了撞名。
      */
      ...(isNew || moved ? {} : { revision: current.revision })
    })
      .then(async (file) => {
        /*
          ★ 顺序是**先写后删**,而且删失败不回滚:写失败的话什么都没发生;
          删失败最坏是磁盘上多一份旧的(用户看得见、能自己删),而反过来
          先删后写一旦写失败,用户的子代理就真没了。
        */
        if (moved) await deleteResource('agent', current.scope, current.name, workspaceId ?? undefined)
        setEditing(file)
        refresh()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false))
  }

  const remove = (): void => {
    const current = editing
    if (current === null) return
    // 还没落盘的那一份没有文件可删,直接退回列表。
    // ★ 这里不再确认一次:两个视图各自都有自己的确认弹窗(表单视图在
    //   `AgentEditor` 里,源码视图在 `MarkdownResourceEditor` 里),再弹一次
    //   就成了连点两下才删得掉。
    if (current.revision === '') { setEditing(null); return }
    void deleteResource('agent', current.scope, current.name, workspaceId ?? undefined)
      .then(() => { setEditing(null); refresh() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  if (editing !== null) {
    return (
      <AgentEditor
        // 换一行编辑(或者存完改名)就重建表单状态,免得上一条的草稿串到下一条。
        key={`${editing.scope}:${editing.name}:${editing.path}`}
        file={editing}
        taken={new Set(rows.map((row) => `${row.scope}:${row.name}`))}
        onSave={save}
        onDelete={remove}
        onClose={() => { setEditing(null); setError(null) }}
        saving={saving}
        error={error}
        workspaceId={workspaceId}
      />
    )
  }

  return (
    <ResourceListPane
      rows={rows}
      error={error}
      icon={<Bot size={26} />}
      emptyTitle={t('ext.agents.empty')}
      emptyHint={t('ext.agents.emptyHint')}
      onNew={create}
      onOpen={(row) => { if (row.scope !== 'builtin') open(row.scope, row.name) }}
      onToggle={(row, enabled) => { void setAgentEnabled(row.name, enabled).then(refresh) }}
    />
  )
}
