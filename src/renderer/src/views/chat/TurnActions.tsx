/**
 * 助手回合底部的操作条:复制、重新生成、导出、删除,外加用时/用量读数。
 *
 * ★ **重新生成和删除都会丢历史,所以都走两次点击确认。** 重新生成在实现上是
 * 「把历史截断到这条提问之前,再发一次」—— 对中间某一轮点下去,它**之后的所有
 * 对话都会消失**。这件事从一个回箭头图标上完全看不出来,而它不可撤销。
 * 确认态把图标换成带文案的按钮,让代价显式说出来。
 *
 * ★ 确认态要有超时。用户点了第一下之后走开,回来时按钮不该还停在「再点一下就删」
 * 的状态上 —— 那时他早忘了自己点过什么。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Download, RotateCcw, Trash2 } from 'lucide-react'
import { formatDuration } from '../../../../shared/agent/duration'
import { copyText, saveTextFile } from '../../services/app'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'

/** 待确认状态自动复位的时长。与代码块「已复制」的 2.2s 同量级,但留得久一点。 */
const CONFIRM_TIMEOUT_MS = 4000

export interface TurnPrompt {
  id: string
  text: string
}

export function TurnActions({
  text,
  prompt,
  alwaysVisible,
  disabled,
  durationMs,
  usage,
  onRegenerate,
  onDelete
}: {
  /** 这一轮的散文正文。为空(纯工具轮)时复制与导出没有意义。 */
  text: string
  /** 引出这一轮的用户提问。缺失时不能重新生成,也不能删除。 */
  prompt?: TurnPrompt
  /** 最后一轮常驻显示;更早的回合悬停才浮现,避免整屏都是按钮。 */
  alwaysVisible: boolean
  /** 运行中禁用所有会改历史的操作 —— store 侧也会拒绝,这里只是别让用户白点。 */
  disabled: boolean
  durationMs?: number
  /** 用量读数(带缓存明细的浮层)。只有携带 run 用量的那一轮会传。 */
  usage?: ReactNode
  onRegenerate?: (id: string, text: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
}): ReactNode {
  const { t } = useI18n()
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [exported, setExported] = useState<'idle' | 'done' | 'failed'>('idle')
  const [confirm, setConfirm] = useState<'none' | 'regenerate' | 'delete'>('none')

  useEffect(() => { setCopy('idle') }, [text])
  useEffect(() => {
    if (copy === 'idle') return
    const timer = setTimeout(() => setCopy('idle'), 2200)
    return () => clearTimeout(timer)
  }, [copy])
  useEffect(() => {
    if (exported === 'idle') return
    const timer = setTimeout(() => setExported('idle'), 2200)
    return () => clearTimeout(timer)
  }, [exported])
  useEffect(() => {
    if (confirm === 'none') return
    const timer = setTimeout(() => setConfirm('none'), CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [confirm])

  const hasText = text.trim() !== ''
  const canRewrite = prompt !== undefined && !disabled

  // 一整轮都没产出散文、又没有提问可依附时,这条操作条没有任何可点的东西。
  if (!hasText && !canRewrite && usage === undefined && durationMs === undefined) return null

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 text-fg-faint transition-opacity',
        // focus-within 保证键盘用户也能走到这些按钮 —— 只挂 group-hover 的话,
        // Tab 过去按钮有焦点却是透明的。
        alwaysVisible ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100'
      )}
      data-testid="turn-actions"
    >
      {hasText && (
        <ActionButton
          label={t(copy === 'failed' ? 'chat.turn.copyFailed' : copy === 'copied' ? 'chat.turn.copied' : 'chat.turn.copy')}
          testId="turn-copy"
          onClick={() => {
            void copyText(text).then(() => setCopy('copied')).catch(() => setCopy('failed'))
          }}
        >
          {copy === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        </ActionButton>
      )}

      {canRewrite && (
        <ActionButton
          label={confirm === 'regenerate' ? t('chat.turn.regenerateConfirm') : t('chat.turn.regenerate')}
          testId="turn-regenerate"
          text={confirm === 'regenerate' ? t('chat.turn.regenerateConfirm') : undefined}
          tone={confirm === 'regenerate' ? 'warn' : 'plain'}
          onClick={() => {
            if (confirm !== 'regenerate') { setConfirm('regenerate'); return }
            setConfirm('none')
            void onRegenerate?.(prompt.id, prompt.text)
          }}
        >
          <RotateCcw size={13} />
        </ActionButton>
      )}

      {hasText && (
        <ActionButton
          label={t(exported === 'failed' ? 'chat.turn.exportFailed' : exported === 'done' ? 'chat.turn.exported' : 'chat.turn.export')}
          testId="turn-export"
          onClick={() => {
            void saveTextFile(exportFileName(prompt?.text ?? text), exportMarkdown(prompt?.text, text))
              // null = 用户在系统对话框里取消了。那不是失败,不该给成功反馈。
              .then((saved) => { if (saved !== null) setExported('done') })
              .catch(() => setExported('failed'))
          }}
        >
          {exported === 'done' ? <Check size={13} /> : <Download size={13} />}
        </ActionButton>
      )}

      {canRewrite && onDelete !== undefined && (
        <ActionButton
          label={confirm === 'delete' ? t('common.confirmDelete') : t('chat.turn.delete')}
          testId="turn-delete"
          text={confirm === 'delete' ? t('common.confirmDelete') : undefined}
          tone={confirm === 'delete' ? 'danger' : 'plain'}
          onClick={() => {
            if (confirm !== 'delete') { setConfirm('delete'); return }
            setConfirm('none')
            void onDelete(prompt.id)
          }}
        >
          <Trash2 size={13} />
        </ActionButton>
      )}

      {durationMs !== undefined && (
        <span className="ml-1.5 text-[11px]" data-testid="turn-duration">
          {t('chat.run.elapsed', { duration: formatDuration(durationMs) })}
        </span>
      )}
      {usage !== undefined && <span className="ml-1.5 text-fg-faint/60">·</span>}
      {usage}
    </div>
  )
}

function ActionButton({
  children,
  label,
  text,
  tone = 'plain',
  testId,
  onClick
}: {
  children: ReactNode
  label: string
  /** 给出文案就渲染成「图标 + 字」—— 确认态靠它把代价说出来。 */
  text?: string
  tone?: 'plain' | 'warn' | 'danger'
  testId: string
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-[6px] p-1 transition-colors hover:bg-tint-hover',
        text !== undefined && 'px-1.5',
        tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-fg' : 'hover:text-fg-muted'
      )}
    >
      {children}
      {text !== undefined && <span className="text-[11px]">{text}</span>}
    </button>
  )
}

/**
 * 导出的正文。带上提问,导出的文件才是**自洽的** —— 只有一段答案的 md
 * 发给别人,对方看不出问的是什么。提问用引用块,与回复正文区分开。
 */
export function exportMarkdown(prompt: string | undefined, reply: string): string {
  const question = prompt?.trim() ?? ''
  if (question === '') return `${reply}\n`
  const quoted = question.split('\n').map((line) => `> ${line}`).join('\n')
  return `${quoted}\n\n${reply}\n`
}

/**
 * 建议文件名 —— 取首行前 40 字。
 *
 * ★ 换行必须先截掉。提问常常是多行的,把整段塞进 defaultPath 会得到一个
 * 名字里带换行的文件。主进程侧还会再洗一遍路径分隔符。
 */
export function exportFileName(source: string): string {
  const head = source.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  const title = head.slice(0, 40).trim()
  return `${title === '' ? 'reply' : title}.md`
}
