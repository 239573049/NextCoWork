import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { InteractionResponse, PendingInteraction } from '../../../../shared/agent/interaction'
import { useI18n } from '../../i18n'
import { AgentMarkdown } from '../../components/markdown'
import { listInteractions, onAgentEvent, respondInteraction } from '../../services/agent'

/** Includes descendant runs: a child waiting for approval must not leave its parent stuck. */
export function InteractionPanel({ runId }: { runId: string }): ReactNode {
  const { t } = useI18n()
  const [pending, setPending] = useState<PendingInteraction[]>([])
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let disposed = false
    let version = 0
    const refresh = (): void => {
      const current = ++version
      void listInteractions(runId).then((items) => {
        if (disposed || current !== version) return
        setPending(items)
        setFailed(false)
      }).catch(() => {
        if (!disposed && current === version) setFailed(true)
      })
    }
    // Subscribe before querying, so an interaction created during the query is not lost.
    const off = onAgentEvent((envelope) => {
      if (envelope.events.some((event) => event.type === 'interaction_request' || event.type === 'interaction_resolved'
        || event.type === 'subagent_start' || event.type === 'run_end')) refresh()
    })
    refresh()
    return () => { disposed = true; off() }
  }, [runId, reload])
  if (pending.length === 0 && !failed) return null
  return (
    <div className="w-full" aria-live="polite">
      {failed && <button type="button" onClick={() => setReload((v) => v + 1)} className="text-[12px] text-danger">
        {t('agent.interaction.loadFailed')}
      </button>}
      {pending.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction}
        onAnswered={() => setPending((items) => items.filter((item) => item.id !== interaction.id))} />)}
    </div>
  )
}

function InteractionCard({ interaction, onAnswered }: { interaction: PendingInteraction; onAnswered: () => void }): ReactNode {
  const { t } = useI18n()
  const [answer, setAnswer] = useState('')
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState(interaction.kind === 'tool_permission' ? JSON.stringify(interaction.input, null, 2) : '')
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  async function respond(response: InteractionResponse): Promise<void> {
    if (busy) return
    setBusy(true)
    setErrorKey(null)
    try { await respondInteraction(response); onAnswered() }
    catch { setErrorKey('agent.interaction.failed'); setBusy(false) }
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (interaction.kind === 'tool_permission') {
      let value: unknown = interaction.input
      if (editing) {
        try { value = JSON.parse(input ?? '') } catch { setErrorKey('agent.interaction.invalidJson'); return }
      }
      void respond({ id: interaction.id, kind: interaction.kind, decision: editing ? { kind: 'allow_edited', input: value } : { kind: 'allow_once' } })
    } else if (interaction.kind === 'ask_user') {
      if (answer.trim() === '') return
      void respond({ id: interaction.id, kind: interaction.kind, answer: answer.trim() })
    } else {
      void respond({ id: interaction.id, kind: interaction.kind, approved: true, feedback: answer })
    }
  }

  const title = interaction.kind === 'tool_permission' ? t('agent.interaction.permission', { tool: interaction.toolName })
    : interaction.kind === 'ask_user' ? t('agent.interaction.question') : t('agent.interaction.plan')
  const button = 'rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-tint disabled:opacity-50'
  return (
    <form onSubmit={submit} data-testid="agent-interaction" data-interaction-kind={interaction.kind}
      className="mb-2 rounded-card border border-accent-soft/40 bg-surface-raised p-3 text-fg">
      <h2 className="mb-2 text-[13px] font-medium">{title}</h2>
      <div className="scroll-thin max-h-[30vh] overflow-auto">
        {interaction.kind === 'tool_permission' ? <>
          {interaction.destructive && <p className="mb-2 text-[12px] text-fg-muted">{t('agent.interaction.changes')}</p>}
          {editing ? <textarea aria-label={t('agent.interaction.arguments')} value={input} onChange={(e) => setInput(e.target.value)}
            disabled={busy} rows={5} className="w-full rounded-lg border border-border bg-app p-2 font-mono text-[12px]" />
            : <pre className="selectable whitespace-pre-wrap break-all text-[12px]">{input}</pre>}
          <button type="button" disabled={busy} className="mt-2 text-[12px] text-fg-muted" onClick={() => {
            if (editing) setInput(JSON.stringify(interaction.input, null, 2))
            setEditing((v) => !v)
          }}>
            {t(editing ? 'agent.interaction.keepOriginal' : 'agent.interaction.editArguments')}
          </button>
        </> : <>
          <AgentMarkdown className="mb-2" content={interaction.kind === 'ask_user' ? interaction.question : interaction.plan} />
          {interaction.kind === 'ask_user' && interaction.choices?.map((choice, index) => <label key={`${index}:${choice}`} className="mb-1 flex items-center gap-2 text-[13px]">
            <input type="radio" name={interaction.id} checked={answer === choice} onChange={() => setAnswer(choice)} disabled={busy} />{choice}
          </label>)}
          {(interaction.kind === 'plan_approval' || interaction.allowFreeform) && <textarea
            aria-label={t(interaction.kind === 'ask_user' ? 'agent.interaction.answer' : 'agent.interaction.feedback')}
            placeholder={t(interaction.kind === 'ask_user' ? 'agent.interaction.answer' : 'agent.interaction.feedback')}
            value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} maxLength={32768} disabled={busy}
            className="mt-1 w-full rounded-lg border border-border bg-app p-2 text-[13px]" />}
        </>}
      </div>
      {errorKey !== null && <p role="alert" className="mt-2 text-[12px] text-danger">{t(errorKey)}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={busy} className={button} onClick={() => {
          if (interaction.kind === 'tool_permission') void respond({ id: interaction.id, kind: interaction.kind, decision: { kind: 'deny' } })
          else if (interaction.kind === 'ask_user') void respond({ id: interaction.id, kind: interaction.kind, answer: null })
          else void respond({ id: interaction.id, kind: interaction.kind, approved: false, feedback: answer })
        }}>{t(interaction.kind === 'ask_user' ? 'agent.interaction.dismiss' : 'agent.interaction.deny')}</button>
        <button type="submit" disabled={busy || (interaction.kind === 'ask_user' && answer.trim() === '')}
          className={`${button} bg-accent text-white`}>
          {t(busy ? 'agent.interaction.sending' : interaction.kind === 'tool_permission'
            ? 'agent.interaction.allowOnce' : interaction.kind === 'ask_user' ? 'agent.interaction.submit' : 'agent.interaction.approvePlan')}
        </button>
      </div>
    </form>
  )
}
