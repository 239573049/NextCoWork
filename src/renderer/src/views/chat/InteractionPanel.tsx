import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AskUserQuestion,
  InteractionResponse,
  PendingInteraction
} from '../../../../shared/agent/interaction'
import { useI18n, type Translate } from '../../i18n'
import { AgentMarkdown } from '../../components/markdown'
import { CheckboxCards, RadioCards } from '../../components/ui/ChoiceCards'
import { Segmented } from '../../components/ui/Segmented'
import { listInteractions, onAgentEvent, respondInteraction } from '../../services/agent'
import {
  choiceOptions, deriveAnswers, initialDraft, isComplete, nextUnanswered, shouldAdvance, showsInput,
  toggle, type AskUserDraft
} from './ask-user'

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

/** 提交这件事三类交互是同一份:一次只允许一发,失败留在原地让用户重试。 */
function useRespond(onAnswered: () => void): {
  busy: boolean
  errorKey: string | null
  setErrorKey: (key: string | null) => void
  respond: (response: InteractionResponse) => void
} {
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  return {
    busy,
    errorKey,
    setErrorKey,
    respond: (response) => {
      if (busy) return
      setBusy(true)
      setErrorKey(null)
      void respondInteraction(response).then(onAnswered).catch(() => {
        setErrorKey('agent.interaction.failed')
        setBusy(false)
      })
    }
  }
}

const BUTTON = 'rounded-lg border border-border px-3 py-1.5 text-[12px] transition-colors hover:bg-tint disabled:opacity-50'

/** 三类交互共用的外壳:标题、可滚动的主体、错误行、右下角两颗按钮。 */
function CardShell({
  kind, title, header, children, errorKey, busy, dismissLabel, submitLabel, canSubmit, onDismiss,
  onSubmit, onPrimary, bodyClassName
}: {
  kind: PendingInteraction['kind']
  title: string
  /** 标题下面那条固定不滚动的东西(多题时的切换条) */
  header?: ReactNode
  children: ReactNode
  errorKey: string | null
  busy: boolean
  dismissLabel: string
  submitLabel: string
  canSubmit: boolean
  onDismiss: () => void
  onSubmit: (event: FormEvent) => void
  /** 给了它,右下角那颗就不是提交键,而是一颗普通按钮(多题时的「下一题」) */
  onPrimary?: () => void
  bodyClassName?: string
}): ReactNode {
  const { t } = useI18n()
  return (
    <form onSubmit={onSubmit} data-testid="agent-interaction" data-interaction-kind={kind}
      className="mb-2 rounded-card border border-accent-soft/40 bg-surface-raised p-3 text-fg">
      <h2 className="mb-2 text-[13px] font-medium">{title}</h2>
      {header}
      <div className={`scroll-thin overflow-auto ${bodyClassName ?? 'max-h-[30vh]'}`}>{children}</div>
      {errorKey !== null && <p role="alert" className="mt-2 text-[12px] text-danger">{t(errorKey)}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={busy} className={BUTTON} onClick={onDismiss}>{dismissLabel}</button>
        <button type={onPrimary === undefined ? 'submit' : 'button'} onClick={onPrimary}
          disabled={busy || (onPrimary === undefined && !canSubmit)}
          className={`${BUTTON} bg-accent text-accent-fg`}>
          {busy ? t('agent.interaction.sending') : submitLabel}
        </button>
      </div>
    </form>
  )
}

function InteractionCard({ interaction, onAnswered }: { interaction: PendingInteraction; onAnswered: () => void }): ReactNode {
  return interaction.kind === 'ask_user'
    ? <AskUserCard interaction={interaction} onAnswered={onAnswered} />
    : <ApprovalCard interaction={interaction} onAnswered={onAnswered} />
}

function AskUserCard({ interaction, onAnswered }: {
  interaction: Extract<PendingInteraction, { kind: 'ask_user' }>
  onAnswered: () => void
}): ReactNode {
  const { t } = useI18n()
  const { busy, errorKey, respond } = useRespond(onAnswered)
  const questions = interaction.questions
  // 每道题两份状态:选中的项 + 「其它」里写的字。分开存,用户在选项之间来回切时,
  // 已经写好的那句话才不会被清掉 —— 推导规则都在 `./ask-user`。
  const [draft, setDraft] = useState<AskUserDraft>(() => initialDraft(questions))
  // ★ **一次只渲染一道题。** 三道题铺开就得滚动,而滚动条上面那半截会被误认为
  // 「就这些了」—— 用户答完看得见的部分就去点提交,然后发现按钮是灰的,却不知道
  // 还差哪一道。切换条把「一共几道、答了几道」摆在固定位置,不随内容滚走。
  const [active, setActive] = useState(0)
  const answers = deriveAnswers(questions, draft)
  const answered = answers.filter((answer) => answer.length > 0).length
  const complete = isComplete(answers)
  const question = questions[active] ?? questions[0]!
  const multi = questions.length > 1
  // 没答完时右下角那颗是「下一题」而不是一颗按不动的灰键 —— 灰键只说明「不行」,
  // 不说明「下一步该干嘛」,而这里恰好有明确的下一步。
  const goNext = complete ? null : nextUnanswered(answers, active)

  return (
    <CardShell
      kind="ask_user"
      title={t('agent.interaction.question')}
      bodyClassName="max-h-[46vh]"
      header={multi ? (
        // 题头可能长,窄窗口下让它横向滚,而不是把卡片撑破
        <div className="scroll-thin mb-2 overflow-x-auto pb-1">
          <Segmented
            size="sm"
            disabled={busy}
            label={t('agent.interaction.question')}
            value={String(active)}
            onChange={(value) => setActive(Number(value))}
            options={questions.map((q, index) => ({
              value: String(index),
              // 打钩的那道已经答过 —— 切换条同时是进度表
              label: (answers[index] ?? []).length > 0 ? `✓ ${q.header}` : q.header
            }))}
          />
        </div>
      ) : undefined}
      errorKey={errorKey}
      busy={busy}
      canSubmit={complete}
      dismissLabel={t('agent.interaction.dismiss')}
      submitLabel={goNext !== null
        ? t('agent.interaction.nextQuestion')
        : multi
          ? t('agent.interaction.submitProgress', { done: String(answered), total: String(questions.length) })
          : t('agent.interaction.submit')}
      onPrimary={goNext === null ? undefined : () => setActive(goNext)}
      onDismiss={() => respond({ id: interaction.id, kind: 'ask_user', answers: null })}
      onSubmit={(event) => {
        event.preventDefault()
        if (!complete) return
        respond({ id: interaction.id, kind: 'ask_user', answers })
      }}
    >
      <QuestionBlock
        key={active}
        question={question}
        index={active}
        busy={busy}
        picked={draft.picked[active] ?? []}
        typed={draft.typed[active] ?? ''}
        onPicked={(next) => {
          setDraft((d) => ({ ...d, picked: d.picked.map((v, i) => (i === active ? next : v)) }))
          // 单选题选完就往下走 —— 但要拿「答完这道之后」的答案去找下一道,
          // 用当前的 `answers` 会把刚答的这道也算成没答,原地打转。
          if (!shouldAdvance(question, next)) return
          const after = answers.map((answer, i) => (i === active ? next : answer))
          const target = nextUnanswered(after, active)
          if (target !== null) setActive(target)
        }}
        onTyped={(next) => setDraft((d) => ({ ...d, typed: d.typed.map((v, i) => (i === active ? next : v)) }))}
        t={t}
      />
    </CardShell>
  )
}

function QuestionBlock({ question, index, busy, picked, typed, onPicked, onTyped, t }: {
  question: AskUserQuestion
  index: number
  busy: boolean
  picked: string[]
  typed: string
  onPicked: (next: string[]) => void
  onTyped: (next: string) => void
  t: Translate
}): ReactNode {
  const options = choiceOptions(question, t('agent.interaction.other'))
  const showInput = showsInput(question, picked)

  return (
    <section data-testid="agent-question" data-question-index={index}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-pill bg-tint px-2 py-0.5 text-[11px] leading-[1.6] text-fg-muted">{question.header}</span>
        {question.multiSelect && <span className="text-[11px] text-fg-faint">{t('agent.interaction.multiSelect')}</span>}
      </div>
      <AgentMarkdown className="mb-2" content={question.question} />
      {options.length > 0 && (question.multiSelect
        ? <CheckboxCards values={picked} options={options} disabled={busy}
          ariaLabel={question.header} onToggle={(value) => onPicked(toggle(options, picked, value))} />
        : <RadioCards value={picked[0] ?? ''} options={options} disabled={busy}
          ariaLabel={question.header} onValueChange={(value) => onPicked([value])} />)}
      {showInput && <textarea
        // 选了「其它」之后输入框才出现,焦点得跟过去,否则用户要再点一下才能写
        autoFocus={question.options.length > 0}
        aria-label={t('agent.interaction.answer')}
        placeholder={t('agent.interaction.answer')}
        value={typed} onChange={(e) => onTyped(e.target.value)} rows={2} maxLength={32768} disabled={busy}
        name={`answer-${index}`}
        className="mt-1.5 w-full resize-none rounded-[8px] border border-border bg-surface-field px-2.5 py-2 text-[13px] leading-[1.6] text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent disabled:opacity-40"
      />}
    </section>
  )
}

/** 工具授权与方案审批 —— 这两类都是「一个是非题 + 一段可选的补充」。 */
function ApprovalCard({ interaction, onAnswered }: {
  interaction: Extract<PendingInteraction, { kind: 'tool_permission' | 'plan_approval' }>
  onAnswered: () => void
}): ReactNode {
  const { t } = useI18n()
  const { busy, errorKey, setErrorKey, respond } = useRespond(onAnswered)
  const [feedback, setFeedback] = useState('')
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState(interaction.kind === 'tool_permission' ? JSON.stringify(interaction.input, null, 2) : '')

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (interaction.kind === 'tool_permission') {
      let value: unknown = interaction.input
      if (editing) {
        try { value = JSON.parse(input ?? '') } catch { setErrorKey('agent.interaction.invalidJson'); return }
      }
      respond({ id: interaction.id, kind: interaction.kind,
        decision: editing ? { kind: 'allow_edited', input: value } : { kind: 'allow_once' } })
    } else {
      respond({ id: interaction.id, kind: interaction.kind, approved: true, feedback })
    }
  }

  return (
    <CardShell
      kind={interaction.kind}
      title={interaction.kind === 'tool_permission'
        ? t('agent.interaction.permission', { tool: interaction.toolName })
        : t('agent.interaction.plan')}
      errorKey={errorKey}
      busy={busy}
      canSubmit
      dismissLabel={t('agent.interaction.deny')}
      submitLabel={t(interaction.kind === 'tool_permission' ? 'agent.interaction.allowOnce' : 'agent.interaction.approvePlan')}
      onDismiss={() => {
        if (interaction.kind === 'tool_permission') respond({ id: interaction.id, kind: interaction.kind, decision: { kind: 'deny' } })
        else respond({ id: interaction.id, kind: interaction.kind, approved: false, feedback })
      }}
      onSubmit={submit}
    >
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
        <AgentMarkdown className="mb-2" content={interaction.plan} />
        <textarea aria-label={t('agent.interaction.feedback')} placeholder={t('agent.interaction.feedback')}
          value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} maxLength={32768} disabled={busy}
          className="mt-1 w-full rounded-lg border border-border bg-app p-2 text-[13px]" />
      </>}
    </CardShell>
  )
}
