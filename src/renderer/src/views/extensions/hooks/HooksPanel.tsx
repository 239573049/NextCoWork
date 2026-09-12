/**
 * 钩子面板。和命令 / 子代理不同，钩子不是「一个文件一条」，而是两份 JSON 文件里
 * 的两段数组 —— 所以它不复用 `ResourcePanel`，列表按事件分组，编辑走 Dialog。
 */
import { AlertTriangle, Play, Plus, Webhook } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  HOOK_EVENTS,
  defaultTimeoutMs,
  type HookEvent,
  type HookListItem,
  type HookRunReport,
  type HookScope
} from '../../../../../shared/domain/hook'
import { HOOK_TEMPLATES, findHookTemplate } from '../../../../../shared/domain/hook-templates'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { EmptyState } from '../../../components/ui/EmptyState'
import { NumberInput } from '../../../components/ui/NumberInput'
import { Segmented } from '../../../components/ui/Segmented'
import { Select } from '../../../components/ui/Select'
import { TextArea } from '../../../components/ui/TextArea'
import { TextInput } from '../../../components/ui/TextInput'
import { Toggle } from '../../../components/ui/Toggle'
import { useI18n } from '../../../i18n'
import {
  deleteHook,
  hookDiagnostics,
  listHooks,
  onHooksChanged,
  saveHook,
  setHookEnabled,
  testHook
} from '../../../services/hooks'
import { useWindowStore } from '../../../stores/window'
import { templateToDraft, validateHook, warnHook, type HookDraft } from './hook-form'

const EMPTY_DRAFT = (event: HookEvent): HookDraft => ({
  event,
  matcher: '',
  command: '',
  timeoutSeconds: defaultTimeoutMs(event) / 1000,
  description: '',
  enabled: true
})

export function HooksPanel(): ReactNode {
  const { t } = useI18n()
  const workspaceId = useWindowStore((s) => s.activeWorkspaceId)
  const [rows, setRows] = useState<HookListItem[]>([])
  const [diagnostics, setDiagnostics] = useState<Array<{ path: string; message: string }>>([])
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<{ draft: HookDraft; id?: string; scope: HookScope } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HookRunReport | null>(null)

  const test = (): void => {
    if (editing === null || validateHook(editing.draft) !== null) return
    setTesting(true)
    setTestResult(null)
    void testHook(
      editing.scope,
      editing.draft.event,
      editing.draft.command.trim(),
      Math.round(editing.draft.timeoutSeconds * 1000),
      workspaceId ?? undefined
    )
      .then(setTestResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setTesting(false))
  }

  const refresh = useCallback(() => {
    void listHooks(workspaceId ?? undefined).then(setRows).catch(() => setError(t('ext.error.loadFailed')))
    void hookDiagnostics(workspaceId ?? undefined).then(setDiagnostics).catch(() => undefined)
  }, [workspaceId, t])

  useEffect(() => {
    refresh()
    return onHooksChanged(refresh)
  }, [refresh])

  const save = (): void => {
    if (editing === null) return
    const { draft, id, scope } = editing
    if (validateHook(draft) !== null) return
    setError(null)
    void saveHook(
      scope,
      {
        ...(id === undefined ? {} : { id }),
        event: draft.event,
        ...(draft.matcher.trim() === '' ? {} : { matcher: draft.matcher.trim() }),
        command: draft.command.trim(),
        enabled: draft.enabled,
        timeoutMs: Math.round(draft.timeoutSeconds * 1000),
        ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() })
      },
      workspaceId ?? undefined
    )
      .then(() => { setEditing(null); refresh() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const remove = (row: HookListItem): void => {
    void deleteHook(row.scope, row.id, workspaceId ?? undefined)
      .then(refresh)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const invalid = editing === null ? null : validateHook(editing.draft)
  const warning = editing === null ? null : warnHook(editing.draft)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <span className="text-[12px] text-fg-faint">{t('hooks.runNote')}</span>
        <Button
          size="sm"
          variant="accent"
          icon={<Plus size={13} />}
          className="ml-auto"
          onClick={() =>
            setEditing({ draft: EMPTY_DRAFT('PreToolUse'), scope: workspaceId === null ? 'global' : 'project' })
          }
        >
          {t('ext.new')}
        </Button>
      </div>

      {error !== null && <p className="shrink-0 px-4 pb-1 text-[11px] text-danger" role="alert">{error}</p>}
      {diagnostics.map((d) => (
        <p key={d.path} className="shrink-0 px-4 pb-1 text-[11px] text-warning" role="status">
          <AlertTriangle size={11} className="mr-1 inline" />
          {d.message} — {d.path}
        </p>
      ))}

      {rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon={<Webhook size={26} />} title={t('ext.hooks.empty')} hint={t('ext.hooks.emptyHint')} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {HOOK_EVENTS.filter((e) => rows.some((r) => r.event === e)).map((event) => (
            <section key={event} className="mb-3">
              <h2 className="mb-1 text-[11px] uppercase tracking-wide text-fg-faint">{event}</h2>
              <ul className="flex flex-col gap-1">
                {rows.filter((r) => r.event === event).map((row) => (
                  <li key={`${row.scope}:${row.id}`} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-tint">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() =>
                        setEditing({
                          id: row.id,
                          scope: row.scope,
                          draft: {
                            event: row.event,
                            matcher: row.matcher ?? '',
                            command: row.command,
                            timeoutSeconds: row.timeoutMs / 1000,
                            description: row.description ?? '',
                            enabled: row.enabled
                          }
                        })
                      }
                    >
                      <span className="block truncate font-mono text-[12px] text-fg">{row.command}</span>
                      <span className="block truncate text-[11px] text-fg-faint">
                        {row.matcher ?? t('hooks.anyTool')}
                        {row.description === undefined ? '' : ` · ${row.description}`}
                      </span>
                    </button>
                    <span className="shrink-0 rounded-pill bg-tint px-2 py-0.5 text-[10px] text-fg-muted">
                      {row.scope === 'project' ? t('ext.scope.project') : t('ext.scope.global')}
                    </span>
                    <Toggle
                      checked={row.enabled}
                      label={t('ext.toggleLabel', { name: row.command })}
                      onChange={(v) => {
                        void setHookEnabled(row.scope, row.id, v, workspaceId ?? undefined).then(refresh)
                      }}
                    />
                    <Button size="sm" variant="danger" onClick={() => remove(row)}>{t('ext.delete')}</Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Dialog
        title={t('hooks.editTitle')}
        open={editing !== null}
        onClose={() => setEditing(null)}
        width={560}
        footer={
          <>
            <Button size="sm" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button size="sm" variant="accent" onClick={save} disabled={invalid !== null}>{t('ext.save')}</Button>
          </>
        }
      >
        {editing !== null && (
          <div className="flex flex-col gap-3">
            {/*
              模板只**填充表单**，不直接保存 —— 钩子执行本机命令，哪怕内容无害，
              「装了应用就开始跑」这件事也该由用户点头。选完还能改、还能试运行。
            */}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-muted">{t('hooks.field.template')}</span>
              <Select
                inModal
                value=""
                ariaLabel={t('hooks.field.template')}
                options={[
                  { value: '', label: t('hooks.template.pick') },
                  ...HOOK_TEMPLATES.map((tpl) => ({
                    value: tpl.id,
                    label:
                      t(`hooks.template.${tpl.id}` as 'hooks.template.danger-guard') +
                      (tpl.platform === 'darwin' ? ' (macOS)' : '')
                  }))
                ]}
                onValueChange={(id) => {
                  const tpl = findHookTemplate(id)
                  if (tpl === undefined) return
                  setTestResult(null)
                  setEditing({
                    ...editing,
                    draft: templateToDraft(tpl, t(`hooks.template.${tpl.id}` as 'hooks.template.danger-guard'))
                  })
                }}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-muted">{t('hooks.field.event')}</span>
              <Select
                inModal
                value={editing.draft.event}
                ariaLabel={t('hooks.field.event')}
                options={HOOK_EVENTS.map((e) => ({ value: e, label: `${e} — ${t(`hooks.event.${e}` as 'hooks.event.PreToolUse')}` }))}
                onValueChange={(v) =>
                  setEditing({ ...editing, draft: { ...editing.draft, event: v as HookEvent } })
                }
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-muted">{t('hooks.field.matcher')}</span>
              <TextInput
                value={editing.draft.matcher}
                onChange={(v) => setEditing({ ...editing, draft: { ...editing.draft, matcher: v } })}
                placeholder={t('hooks.field.matcherHint')}
                ariaLabel={t('hooks.field.matcher')}
                invalid={invalid === 'hooks.error.badMatcher'}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-muted">{t('hooks.field.command')}</span>
              <TextArea
                value={editing.draft.command}
                onCommit={(v) => setEditing({ ...editing, draft: { ...editing.draft, command: v } })}
                placeholder="./scripts/guard.sh"
                ariaLabel={t('hooks.field.command')}
                rows={3}
              />
            </label>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <span className="text-[12px] text-fg-muted">{t('hooks.field.timeout')}</span>
                <NumberInput
                  value={editing.draft.timeoutSeconds}
                  onCommit={(v) => setEditing({ ...editing, draft: { ...editing.draft, timeoutSeconds: v } })}
                  ariaLabel={t('hooks.field.timeout')}
                  min={1}
                  max={600}
                />
              </label>
              <Segmented<HookScope>
                size="sm"
                value={editing.scope}
                onChange={(v) => setEditing({ ...editing, scope: v })}
                label={t('ext.scopeFilter')}
                options={[
                  { value: 'global', label: t('ext.scope.global') },
                  ...(workspaceId === null ? [] : [{ value: 'project' as const, label: t('ext.scope.project') }])
                ]}
              />
            </div>

            {warning !== null && (
              <p className="text-[11px] text-warning" role="status">{t(warning as 'hooks.warn.weakMatcher')}</p>
            )}
            {invalid !== null && (
              <p className="text-[11px] text-danger" role="alert">{t(invalid as 'hooks.error.emptyCommand')}</p>
            )}
            <p className="text-[11px] text-fg-faint">{t('hooks.dangerNote')}</p>

            {/*
              ★ 试运行是这一屏性价比最高的控件：钩子的失败模式（脚本路径不对、
              shell 语法、超时）全都只有真跑一次才暴露，而配好之后要等到某次
              工具调用才会触发，那时候错误早就淹没在别的事情里了。
            */}
            <div className="flex items-center gap-2 border-t border-hairline pt-3">
              <Button size="sm" icon={<Play size={13} />} onClick={test} disabled={invalid !== null || testing}>
                {testing ? t('hooks.testing') : t('hooks.test')}
              </Button>
              {workspaceId === null && <span className="text-[11px] text-fg-faint">{t('hooks.testNeedsWorkspace')}</span>}
            </div>
            {testResult !== null && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-input p-2 font-mono text-[11px] text-fg-muted">
                {t('hooks.testResult', {
                  outcome: testResult.outcome,
                  code: testResult.exitCode === null ? '-' : String(testResult.exitCode),
                  ms: String(testResult.durationMs)
                })}
                {testResult.stdout === '' ? '' : `\n\nstdout:\n${testResult.stdout}`}
                {testResult.stderr === '' ? '' : `\n\nstderr:\n${testResult.stderr}`}
              </pre>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
