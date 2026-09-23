/**
 * 压缩检查点的**完整**详情面板 —— 分隔线和顶部检查点列表共用同一份。
 *
 * ## 需求
 *
 * 在此之前,压缩这件事在界面上只有一段 note 和一对 token 读数。用户真正要问的
 * 三个问题一个都答不上来:这一刀削了多少、**哪些消息已经不再发给模型**、
 * 摘要是在什么输入上写出来的。第二个问题尤其关键 —— 它决定了「模型怎么突然
 * 不记得了」是 bug 还是预期。
 *
 * 所以这里是三页:
 * 1. **摘要** —— 落库的那段 note(模型摘要可编辑,机械压缩是算出来的事实,只读)。
 * 2. **摘要输入** —— 真正发给摘要模型的 digest 原文,含它自己的截断标记。
 * 3. **压缩后上下文** —— 这条检查点生效后发给模型的那份投影,逐条标明
 *    原文 / 已折叠 / 提要 / 摘要,以及哪些消息已经不在里面了。
 *
 * ★ 第三页**按需拉**(展开那一刻才发 IPC):主进程要把整段转录重投影一遍,
 * 而绝大多数压缩分隔线用户从头到尾都不会展开。
 *
 * ★ 两处调用点共用这一个组件,不是各写一遍:两份的结果必然分头演化,
 * 而「分隔线里能看到丢弃统计、顶部面板里看不到」这种差异不会报错。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Pencil, Save } from 'lucide-react'
import type { ContextCheckpoint, ContextWindowEntry, ContextWindowView } from '../../../../shared/agent/context-management'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { contextWindow, updateContextCheckpoint } from '../../services/context'
import { compactionStats, hasUncoveredGap } from './compaction-detail'

type Tab = 'note' | 'digest' | 'window'

export function CompactionDetail({
  checkpoint,
  /** 机械压缩的 note 是按规则重算的事实,放出编辑框只会让改动无声蒸发。 */
  editable,
  onRefresh
}: {
  checkpoint: ContextCheckpoint
  editable: boolean
  onRefresh?: (checkpoint: ContextCheckpoint) => void
}): ReactNode {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('note')
  const stats = compactionStats(checkpoint)
  const digest = checkpoint.detail?.digest

  return (
    <div className="flex flex-col gap-2" data-testid="compaction-detail">
      {stats.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {stats.map((stat) => (
              <span key={stat.key} className="rounded-pill bg-tint px-2 py-0.5 text-[11px] text-fg-faint">
                {t(stat.key, { count: stat.count })}
              </span>
            ))}
          </div>
          {stats.some((stat) => stat.hint !== undefined) && (
            <p className="text-[11px] leading-[1.5] text-fg-faint">{t('context.panel.droppedHint')}</p>
          )}
        </div>
      )}

      {hasUncoveredGap(checkpoint) && (
        <div className="rounded-card bg-warning/10 px-2.5 py-1.5">
          <p className="text-[11px] font-medium text-fg-muted">{t('context.panel.uncovered')}</p>
          <p className="text-[11px] leading-[1.5] text-fg-faint">{t('context.panel.uncoveredHint')}</p>
        </div>
      )}

      <div className="flex items-center gap-1" role="tablist">
        <TabButton active={tab === 'note'} onClick={() => setTab('note')} label={t('context.panel.tabNote')} />
        <TabButton active={tab === 'digest'} onClick={() => setTab('digest')} label={t('context.panel.tabDigest')} />
        <TabButton active={tab === 'window'} onClick={() => setTab('window')} label={t('context.panel.tabWindow')} />
      </div>

      {tab === 'note' && <NoteTab checkpoint={checkpoint} editable={editable} {...(onRefresh === undefined ? {} : { onRefresh })} />}
      {tab === 'digest' && (
        digest === undefined || digest === '' ? (
          <p className="text-[11px] text-fg-faint">{t('context.panel.digestEmpty')}</p>
        ) : (
          <>
            <p className="text-[11px] leading-[1.5] text-fg-faint">{t('context.panel.digestHint')}</p>
            <pre className="scroll-thin max-h-[min(40vh,320px)] overflow-auto rounded border border-hairline bg-surface-input p-2 text-[11px] leading-[1.5] whitespace-pre-wrap break-words text-fg-muted">{digest}</pre>
          </>
        )
      )}
      {tab === 'window' && <WindowTab checkpoint={checkpoint} />}
    </div>
  )
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-pill px-2.5 py-1 text-[11px] transition motion-reduce:transition-none',
        active ? 'bg-tint text-fg' : 'text-fg-faint hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}

function NoteTab({
  checkpoint,
  editable,
  onRefresh
}: {
  checkpoint: ContextCheckpoint
  editable: boolean
  onRefresh?: (checkpoint: ContextCheckpoint) => void
}): ReactNode {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(checkpoint.note)
  const [saving, setSaving] = useState(false)
  /*
    ★ 检查点被外部换掉(压缩落了新读数、或者另一处编辑保存了)时草稿要跟着走,
    否则用户看到的是上一条检查点的笔记,而标题上写着新的窗口号。
  */
  useEffect(() => {
    setNote(checkpoint.note)
    setEditing(false)
  }, [checkpoint.id, checkpoint.note])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      onRefresh?.(await updateContextCheckpoint(checkpoint.id, note, checkpoint.revision))
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {editing ? (
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="min-h-28 w-full resize-y rounded border border-border bg-surface-input p-2 text-[12px] text-fg outline-none focus:border-accent"
          aria-label={t('chat.contextNote')}
        />
      ) : (
        <p className="scroll-thin max-h-[min(40vh,320px)] overflow-y-auto break-words pr-1 whitespace-pre-wrap text-[12px] leading-[1.5] text-fg-muted">{checkpoint.note}</p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {!editable ? (
          <span className="text-[11px] text-fg-faint">{t('chat.compaction.readOnly')}</span>
        ) : editing ? (
          <button type="button" className="inline-flex items-center gap-1 text-[11px] text-accent" onClick={() => void save()} disabled={saving}>
            <Save size={12} aria-hidden />{t('chat.contextSave')}
          </button>
        ) : (
          <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg" onClick={() => setEditing(true)}>
            <Pencil size={12} aria-hidden />{t('chat.contextEdit')}
          </button>
        )}
      </div>
    </>
  )
}

/**
 * 「压缩后真正发给模型的那份」。
 *
 * ★ 拉取发生在**这个子组件挂载时**,也就是用户切到这一页的那一刻 ——
 * 放在父组件里会变成「展开分隔线就发一次 IPC」,而那条请求要把整段转录
 * 重投影一遍。
 */
function WindowTab({ checkpoint }: { checkpoint: ContextCheckpoint }): ReactNode {
  const { t } = useI18n()
  const [view, setView] = useState<ContextWindowView | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let alive = true
    setState('loading')
    contextWindow(checkpoint.sessionId, checkpoint.id)
      .then((next) => {
        if (!alive) return
        // 主进程对「会话没了 / 检查点对不上」回 undefined —— 那是失败,不是空结果。
        if (next === undefined) setState('failed')
        else {
          setView(next)
          setState('ready')
        }
      })
      .catch(() => {
        if (alive) setState('failed')
      })
    return () => {
      alive = false
    }
  }, [checkpoint.sessionId, checkpoint.id])

  if (state === 'loading') return <p className="text-[11px] text-fg-faint">{t('context.panel.windowLoading')}</p>
  if (state === 'failed' || view === undefined) {
    return <p className="text-[11px] text-fg-faint">{t('context.panel.windowFailed')}</p>
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] leading-[1.5] text-fg-faint">{t('context.panel.windowHint')}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
        <span className="rounded-pill bg-tint px-2 py-0.5">
          {t('context.panel.windowTotals', { kept: view.messageTokens, all: view.transcriptTokens })}
        </span>
        {view.droppedMessageIds.length > 0 && (
          <span className="rounded-pill bg-tint px-2 py-0.5">
            {t('context.panel.windowDropped', { count: view.droppedMessageIds.length })}
          </span>
        )}
      </div>
      <ul className="scroll-thin flex max-h-[min(45vh,360px)] flex-col gap-1 overflow-y-auto pr-1">
        {view.entries.map((entry) => (
          <WindowRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </div>
  )
}

function WindowRow({ entry }: { entry: ContextWindowEntry }): ReactNode {
  const { t } = useI18n()
  const kind = t(`context.panel.kind.${entry.kind}` as 'context.panel.kind.summary')
  const role = t(entry.role === 'user' ? 'context.panel.roleUser' : 'context.panel.roleAssistant')
  return (
    <li className="rounded border border-hairline px-2 py-1.5" data-kind={entry.kind}>
      <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
        <span>{role}</span>
        <span aria-hidden className="text-fg-faint/50">·</span>
        <span
          className={cn(
            'rounded-pill px-1.5',
            entry.kind === 'verbatim' ? 'bg-tint' : 'bg-accent/10 text-accent'
          )}
        >
          {kind}
        </span>
        <span className="ml-auto">{t('context.panel.tokens', { count: entry.tokens })}</span>
      </div>
      {entry.lines.length > 0 && (
        <p className="mt-1 line-clamp-3 break-words text-[11px] leading-[1.5] whitespace-pre-wrap text-fg-muted">
          {entry.lines.join('\n')}
        </p>
      )}
    </li>
  )
}
