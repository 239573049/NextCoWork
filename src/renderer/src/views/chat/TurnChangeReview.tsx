/**
 * 助手回合底部的「改动审查」卡 —— 本轮改了哪些文件、+X −Y、撤销/恢复,
 * 展开后每个文件一行:点文件名 = 在审查 tab 里定位到这个文件的 diff,
 * 行尾另有「审查 / 打开」两颗按钮。
 *
 * 数据按**顶层 runId** 拉(`review:getChangeSet`):一轮没改过文件就整卡不渲染。
 * 撤销前先 `review:precheckUndo` 比对磁盘现状,有冲突则二次点击确认(和 TurnActions
 * 的两段式确认同一套心智)。回写后广播 `workspace-files-changed`,让打开着的编辑器刷新。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, Undo2, Redo2 } from 'lucide-react'
import type { ReviewChangeSet, ReviewFileEntry, ReviewMutationResult } from '../../../../shared/domain/review'
import {
  getReviewChangeSet,
  precheckReviewUndo,
  redoReviewChangeSet,
  undoReviewChangeSet
} from '../../services/review'
import { on } from '../../services/ipc'
import { useTabsStore } from '../../stores/tabs'
import { useI18n } from '../../i18n'
import { motionScale, useMotionLevel } from '../../theme/useMotionLevel'
import { cn } from '../../lib/cn'

/** 撤销确认态自动复位 —— 和 TurnActions 的 CONFIRM_TIMEOUT_MS 同量级。 */
const CONFIRM_TIMEOUT_MS = 4000

function announceChanged(workspaceId: string, paths: readonly string[]): void {
  for (const path of paths) {
    window.dispatchEvent(new CustomEvent('workspace-files-changed', { detail: { workspaceId, path, operation: 'save' } }))
  }
}

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

export function TurnChangeReview({
  runId,
  workspaceId,
  sessionId,
  readOnly,
  active = false
}: {
  runId?: string
  workspaceId?: string
  sessionId?: string
  readOnly: boolean
  /** 这一轮是否仍在运行(isLast && running)。用来在结束的一刻补拉改动集。 */
  active?: boolean
}): ReactNode {
  const { t } = useI18n()
  const scale = motionScale(useMotionLevel())
  const [set, setSet] = useState<ReviewChangeSet | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const wasActive = useRef(active)

  useEffect(() => {
    if (runId === undefined) return
    let alive = true
    const load = (): void => {
      getReviewChangeSet(runId)
        .then((s) => {
          if (alive) setSet(s)
        })
        .catch(() => {
          if (alive) setSet(null)
        })
    }
    load()
    // 封包在 run 收尾才落盘 —— 卡片可能早于它挂载(拉到 null),靠这个事件补一次。
    const unsub = on('review:changed', (e) => {
      if (e.runId === runId) load()
    })
    return () => {
      alive = false
      unsub()
    }
  }, [runId])

  // run_end(active→false)先于 finally 的落盘到达,所以结束一刻直接拉会拿到 null。
  // 这里短暂轮询几次直到改动集落盘出现 —— 与 review:changed 事件互为保险,且纯 renderer。
  useEffect(() => {
    const justEnded = wasActive.current && !active
    wasActive.current = active
    if (!justEnded || runId === undefined) return
    let alive = true
    let tries = 0
    const tick = (): void => {
      getReviewChangeSet(runId)
        .then((s) => {
          if (!alive) return
          if (s !== null && s.files.length > 0) {
            setSet(s)
            return
          }
          if (++tries < 6) setTimeout(tick, 300)
        })
        .catch(() => undefined)
    }
    tick()
    return () => {
      alive = false
    }
  }, [active, runId])

  useEffect(() => {
    if (!confirmUndo) return
    const timer = setTimeout(() => setConfirmUndo(false), CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [confirmUndo])

  // 这一轮没改过文件(或还没加载出来)—— 整卡不占位。
  if (runId === undefined || workspaceId === undefined || set === null || set.files.length === 0) return null

  const applied = set.state === 'applied'

  const afterMutation = (result: ReviewMutationResult): void => {
    setSet((prev) => (prev === null ? prev : { ...prev, state: result.state }))
    announceChanged(
      workspaceId,
      result.files.filter((f) => f.status === 'ok').map((f) => f.path)
    )
  }

  const runUndo = async (force: boolean): Promise<void> => {
    setBusy(true)
    try {
      afterMutation(await undoReviewChangeSet(runId, force))
    } finally {
      setBusy(false)
      setConfirmUndo(false)
    }
  }

  const onUndoClick = (): void => {
    if (busy) return
    if (confirmUndo) {
      void runUndo(true)
      return
    }
    // 先比对:磁盘现状与记录不符的文件要用户确认后才覆盖。
    void precheckReviewUndo(runId).then((r) => {
      if (r.conflicts.length > 0) setConfirmUndo(true)
      else void runUndo(false)
    })
  }

  const onRedoClick = (): void => {
    if (busy) return
    setBusy(true)
    redoReviewChangeSet(runId)
      .then(afterMutation)
      .finally(() => setBusy(false))
  }

  /**
   * 审查 tab 一律开在**右侧工作区**。
   *
   * ★ 走 `openChangeReview` 而不是 `open(ws, 'changes', 'right')`:后者在右侧
   *   工作台还没被切出来时会退回当前分组,把审查 tab 开进**主区**、盖住对话。
   *   面板展开也由它负责,所以这里不用再自己 `setRightPanelForWorkspace`。
   */
  const openReviewTab = (selectedPath?: string): void =>
    useTabsStore.getState().openChangeReview(workspaceId, runId, sessionId, selectedPath)

  const openFile = (path: string): void => useTabsStore.getState().openFile(workspaceId, path)

  return (
    <div className="rounded-card bg-surface-raised/60 text-[12px]">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          data-testid="turn-review-toggle"
        >
          <ChevronRight size={13} className={cn('shrink-0 text-fg-faint transition-transform', expanded && 'rotate-90')} />
          <span className="text-fg">{t('chat.review.filesChanged', { count: set.fileCount })}</span>
          <span className="font-mono text-[11px]">
            {set.additions > 0 && <span className="text-accent">+{set.additions}</span>}
            {set.deletions > 0 && <span className="ml-1 text-danger">-{set.deletions}</span>}
          </span>
          {!applied && <span className="ml-1 text-fg-faint">· {t('chat.review.reverted')}</span>}
        </button>
        {!readOnly && (
          <button
            type="button"
            onClick={applied ? onUndoClick : onRedoClick}
            disabled={busy}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5',
              confirmUndo ? 'text-warn' : 'text-fg-faint hover:text-fg',
              busy && 'opacity-50'
            )}
            data-testid="turn-review-undo"
          >
            {applied ? <Undo2 size={12} /> : <Redo2 size={12} />}
            <span>
              {busy
                ? applied
                  ? t('chat.review.undoing')
                  : t('chat.review.redoing')
                : confirmUndo
                  ? t('chat.review.undoConflictConfirm')
                  : applied
                    ? t('chat.review.undo')
                    : t('chat.review.redo')}
            </span>
          </button>
        )}
      </div>

      {/*
        展开/收起是**高度过渡**,不是直接挂载 —— 文件多的时候一下子砸出来,
        下面整条转录会跟着跳一下。`initial={false}` 让首次就已展开的路径不重播
        动画,理由同 ToolTimeline 那段长注释。
        ★ 时长必须乘 `scale`:勾了「减弱动态效果」的用户那里,Motion 走 WAAPI,
        theme.css 那段 CSS 管不到,漏乘就变成「设置关掉了动画但这里还在动」。
      */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="turn-review-files"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 * scale, ease: [0.32, 0.72, 0, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div>
              {set.files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  onReview={() => openReviewTab(file.path)}
                  onOpen={() => openFile(file.path)}
                  t={t}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function FileRow({
  file,
  onReview,
  onOpen,
  t
}: {
  file: ReviewFileEntry
  onReview: () => void
  onOpen: () => void
  t: ReturnType<typeof useI18n>['t']
}): ReactNode {
  const { dir, name } = splitPath(file.path)
  return (
    <div className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 hover:bg-tint-hover">
      {/*
        文件名本身就是「审查这个文件」—— 右边那颗「审查」按钮留着,是因为
        一行文字能不能点从外观上看不出来。整行不做成 <button>:里面还有两颗
        按钮,嵌套 button 在 HTML 里非法,键盘序也会塌成一个焦点。
      */}
      <button
        type="button"
        onClick={onReview}
        title={file.path}
        className="min-w-0 flex-1 cursor-pointer truncate text-left"
      >
        <span className="text-fg">{name}</span>
        {dir !== '' && <span className="ml-1 text-fg-faint">{dir}</span>}
        {!file.oversize && (
          <span className="ml-1.5 font-mono text-[11px]">
            {file.additions > 0 && <span className="text-accent">+{file.additions}</span>}
            {file.deletions > 0 && <span className="ml-1 text-danger">-{file.deletions}</span>}
          </span>
        )}
        {file.oversize && <span className="ml-1.5 text-fg-faint">{t('chat.review.oversize')}</span>}
      </button>
      <button
        type="button"
        onClick={onReview}
        className="shrink-0 rounded-[6px] border border-stroke px-2 py-0.5 text-fg-muted hover:text-fg"
      >
        {t('chat.review.review')}
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 rounded-[6px] border border-stroke px-2 py-0.5 text-fg-muted hover:text-fg"
      >
        {t('chat.review.open')}
      </button>
    </div>
  )
}
