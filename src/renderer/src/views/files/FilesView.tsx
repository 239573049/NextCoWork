/**
 * 工作区文件树 —— 右侧「工作台标签」里默认的那一个。
 *
 * 对着参考截图逐条落下来的行为(顺序就是它们在界面上从上到下的顺序):
 *
 * 1. **`对话文件` / `所有文件` 两档 scope**,左上角,`所有文件` 是加粗那个(选中态)。
 * 2. **工具条会随面板宽度收起**。同一套按钮在宽面板(≈608px)里是七颗全展开
 *    (新建 / 搜索 / 排序 / 隐藏文件 / 全部折叠 / 访达 / 刷新),
 *    在窄面板(≈297px)里只剩「搜索 + `…`」。这不是两套 UI,是**一套按溢出**。
 * 3. **懒加载**。目录默认收起(`>`),展开一层拉一层 —— `node_modules` 不会被整棵拉下来。
 * 4. **目录在前、文件在后**(见 shared 的 `sortEntries`),文件图标按类型上色。
 * 5. **行有三态**:普通 / 悬停(浅底 + 右端冒出 `…`)/ 选中(挖亮底,即当前打开的那个文件)。
 *
 * 点一个文件 → 在**主区**开一个 doc Tab(截图里 `bun.lock` 就是这么进主区的),
 * 所以这个组件不自己渲染文件内容,它只发 `onOpenFile`。
 */
import {
  ArrowUpDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  ListCollapse,
  Loader2,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DirListing, FileEntry, SortBy } from '../../../../shared/domain/file-tree'
import type { InnerTab } from '../../../../shared/domain/tab'
import type { Workspace } from '../../../../shared/domain/workspace'
import type { WorkspaceFileMutationRequest } from '../../../../shared/domain/workspace-file'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { IconButton } from '../../components/ui/IconButton'
import { Menu, MenuItem, MenuSeparator } from '../../components/ui/Menu'
import { cn } from '../../lib/cn'
import { iconFor } from '../../lib/file-icon'
import { listDir } from '../../services/app'
import { mutateWorkspaceFile, revealWorkspaceFile, workspaceFileErrorKey, type WorkspaceFilesChanged } from '../../services/workspace-files'
import { confirmDocumentChanges } from '../../stores/documents'
import { useTabsStore } from '../../stores/tabs'
import { flatten } from './flatten'
import { useI18n, type TranslationKey } from '../../i18n'
import { FileOperationDialog } from './FileOperationDialog'
import { type FileOperationTarget } from './file-operations'

type Scope = 'conversation' | 'all'

/**
 * 工具条全展开需要的宽度。低于它就折进 `…`。
 *
 * 量参考截图定的:窄面板(面板宽 ≈297,工具条可用宽 ≈270)只放得下「搜索 + `…`」,
 * 宽面板(≈608)七颗全在。400 落在两者中间,且留出了 scope 那两个 chip 的位置。
 */
const TOOLBAR_FULL_WIDTH = 400

/** 一层缩进。12 是让第 3 层还看得出层级、又不至于把长文件名挤没的那个值。 */
const INDENT = 12

interface FilesViewProps {
  workspace: Workspace
  /** Workspace-relative subtree root; empty for the workspace root. */
  rootPath: string
  selectedPath: string | null
  onOpenFile: (path: string, name: string) => void
}

export function FilesView(props: FilesViewProps): ReactNode {
  // Scope the full state to the workspace and subtree, including pending dialogs.
  return <WorkspaceFilesView key={`${props.workspace.id}:${props.rootPath}`} {...props} />
}

function WorkspaceFilesView({
  workspace,
  rootPath,
  selectedPath,
  onOpenFile
}: FilesViewProps): ReactNode {
  const { t } = useI18n()
  const scopes: readonly { id: Scope; label: string }[] = [
    { id: 'conversation', label: t('files.conversation') },
    { id: 'all', label: t('files.all') }
  ]
  const [scope, setScope] = useState<Scope>('all')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [showHidden, setShowHidden] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [listings, setListings] = useState<Readonly<Record<string, DirListing>>>({})
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const [operation, setOperation] = useState<FileOperationTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmingChanges, setConfirmingChanges] = useState(false)
  const [operationError, setOperationError] = useState<TranslationKey | null>(null)
  const [notice, setNotice] = useState<{ key: TranslationKey; path?: string; error?: boolean } | null>(null)
  const generation = useRef(0)
  const requests = useRef(new Map<string, number>())
  const sequence = useRef(0)
  const alive = useRef(true)
  const operationRunning = useRef(false)

  const toolbar = useRef<HTMLDivElement>(null)
  const compact = useToolbarCompact(toolbar)

  const load = useCallback(
    (path: string): void => {
      const epoch = generation.current
      const request = ++sequence.current
      requests.current.set(path, request)
      const isCurrent = (): boolean =>
        alive.current && generation.current === epoch && requests.current.get(path) === request
      setLoading((prev) => new Set(prev).add(path))
      void listDir(workspace.id, path)
        .then((l) => {
          if (!isCurrent()) return
          setListings((prev) => ({ ...prev, [path]: l }))
          setFailed((prev) => {
            if (!prev.has(path)) return prev
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return
          // 目录读不到(权限 / 刚被删)只该让**那一行**显示读取失败,
          // 不该把整棵树打空 —— 树是一层一层来的,一层坏不等于整棵坏。
          console.error('[files] 列目录失败:', path, err)
          setFailed((prev) => new Set(prev).add(path))
        })
        .finally(() => {
          if (!isCurrent()) return
          setLoading((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        })
    },
    [workspace.id]
  )

  // 换工作区 / 换子树根:整棵重来。旧工作区的路径在新根下毫无意义,
  // 留着会让第一帧画出上一个项目的文件名。
  useEffect(() => {
    alive.current = true
    generation.current += 1
    setListings({})
    setFailed(new Set())
    setExpanded(new Set())
    load(rootPath)
    return () => {
      alive.current = false
      generation.current += 1
    }
  }, [load, rootPath])

  const toggleDir = (path: string): void => {
    const wasExpanded = expanded.has(path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (wasExpanded && !failed.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (failed.has(path) || (!wasExpanded && listings[path] === undefined)) load(path)
  }

  const refresh = useCallback((paths: ReadonlySet<string> = expanded): void => {
    generation.current += 1
    // Only preserve visible listings while they reload; collapsed folders must
    // read fresh data the next time they are expanded.
    setListings((prev) => Object.fromEntries(
      Object.entries(prev).filter(([path]) => path === rootPath || paths.has(path)),
    ))
    setLoading(new Set())
    setFailed(new Set())
    load(rootPath)
    // 展开状态**留着**:刷新是"重新读盘",不是"把我打开的目录都收起来"
    for (const p of paths) if (p !== rootPath) load(p)
  }, [expanded, load, rootPath])

  useEffect(() => {
    const onFilesChanged = (event: Event): void => {
      const change = (event as CustomEvent<WorkspaceFilesChanged>).detail
      if (change.workspaceId !== workspace.id) return
      const paths = new Set<string>()
      for (const path of expanded) {
        const affected = path === change.path || path.startsWith(`${change.path}/`)
        if (affected && change.operation === 'delete') continue
        paths.add(
          affected && (change.operation === 'move' || change.operation === 'rename') && change.destination
            ? `${change.destination}${path.slice(change.path.length)}`
            : path,
        )
      }
      setExpanded(paths)
      refresh(paths)
    }
    window.addEventListener('workspace-files-changed', onFilesChanged)
    return () => window.removeEventListener('workspace-files-changed', onFilesChanged)
  }, [expanded, refresh, workspace.id])

  const beginOperation = (operation: FileOperationTarget): void => {
    if (operationRunning.current) return
    setOperationError(null)
    setNotice(null)
    setOperation(operation)
  }

  const submitOperation = async (request: WorkspaceFileMutationRequest): Promise<void> => {
    if (operationRunning.current) return
    operationRunning.current = true
    setBusy(true)
    setOperationError(null)
    try {
      if (request.operation === 'rename' || request.operation === 'move' || request.operation === 'delete') {
        setConfirmingChanges(true)
        const confirmed = await confirmDocumentChanges(workspace.id, request.path)
        if (!alive.current) return
        setConfirmingChanges(false)
        if (!confirmed) return
      }
      const result = await mutateWorkspaceFile(request)
      if (!alive.current) return
      const noticeKeys: Record<FileOperationTarget['operation'], TranslationKey> = {
        'create-file': 'files.manage.created',
        'create-directory': 'files.manage.created',
        rename: 'files.manage.renamed',
        copy: 'files.manage.copied',
        move: 'files.manage.moved',
        delete: 'files.manage.deleted',
      }
      setNotice({ key: noticeKeys[request.operation], path: result.destination ?? result.path })
      setOperation(null)
      setScope('all')
      if (request.operation === 'create-file') {
        onOpenFile(result.path, result.path.split('/').at(-1) ?? result.path)
      }
    } catch (error) {
      if (alive.current) {
        const errorKey = workspaceFileErrorKey(error)
        setOperationError(errorKey)
        if (request.operation === 'delete') setNotice({ key: errorKey, error: true })
      }
    } finally {
      operationRunning.current = false
      if (alive.current) {
        setBusy(false)
        setConfirmingChanges(false)
      }
    }
  }

  const reveal = async (path: string): Promise<void> => {
    try {
      await revealWorkspaceFile(workspace.id, path)
    } catch (error) {
      if (alive.current) setNotice({ key: workspaceFileErrorKey(error), error: true })
    }
  }

  const rows = useMemo(
    () => flatten(listings, expanded, rootPath, sortBy, showHidden, query),
    [listings, expanded, rootPath, sortBy, showHidden, query]
  )

  const root = listings[rootPath]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={toolbar} className="flex shrink-0 items-center gap-2 px-2 pb-1.5">
        <div className="flex shrink-0 items-center gap-2">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={scope === s.id}
              onClick={() => setScope(s.id)}
              className={cn(
                'rounded-[6px] px-1 py-0.5 text-[12.5px] transition-colors',
                // 参考里未选中的那个不是灰底按钮,就是一段浅色文字 ——
                // 选中态靠**字重 + 字色**,不靠底色。底色留给下面的树行用。
                scope === s.id ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
          {query === null ? (
            <IconButton label={t('files.search')} size={24} onClick={() => setQuery('')}>
              <Search size={14} />
            </IconButton>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1 rounded-[7px] bg-surface-input px-1.5">
              <Search size={12} className="shrink-0 text-fg-faint" />
              <input
                autoFocus
                value={query}
                aria-label={t('files.search')}
                placeholder={t('files.filterPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery(null)}
                className="min-w-0 flex-1 bg-transparent py-1 text-[12.5px] text-fg outline-none placeholder:text-fg-faint"
              />
              <IconButton label={t('files.closeSearch')} size={18} onClick={() => setQuery(null)}>
                <X size={11} />
              </IconButton>
            </div>
          )}

          {query === null &&
            (compact ? (
              /*
                窄面板:七颗折成一颗 `…`。**同一批动作、同一批 handler** ——
                折叠只是换个呈现,不是另写一套精简版工具条(那必然会慢慢长歪)。
              */
              <Menu
                label={t('files.moreActions')}
                width={190}
                trigger={<MoreHorizontal size={14} />}
                disabled={busy}
                triggerClassName="flex size-6 items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
              >
                {(close) => (
                  <>
                    <MenuItem icon={<FilePlus2 size={14} />} onSelect={() => {
                      beginOperation({ operation: 'create-file', path: rootPath, name: '' })
                      close()
                    }}>
                      {t('files.manage.newFile')}
                    </MenuItem>
                    <MenuItem icon={<FolderPlus size={14} />} onSelect={() => {
                      beginOperation({ operation: 'create-directory', path: rootPath, name: '' })
                      close()
                    }}>
                      {t('files.manage.newDirectory')}
                    </MenuItem>
                    <MenuItem
                      icon={<ArrowUpDown size={14} />}
                      onSelect={() => {
                        cycleSort(setSortBy)
                        close()
                      }}
                    >
                      {sortLabel(t, sortBy)}
                    </MenuItem>
                    <MenuItem
                      icon={showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      onSelect={() => {
                        setShowHidden((v) => !v)
                        close()
                      }}
                    >
                      {showHidden ? t('files.hideHidden') : t('files.showHidden')}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      icon={<ListCollapse size={14} />}
                      onSelect={() => {
                        setExpanded(new Set())
                        close()
                      }}
                    >
                      {t('files.collapseAll')}
                    </MenuItem>
                    <MenuItem icon={<FolderOpen size={14} />} onSelect={() => {
                      void reveal(rootPath)
                      close()
                    }}>
                      {t('files.manage.reveal')}
                    </MenuItem>
                    <MenuItem
                      icon={<RefreshCw size={14} />}
                      onSelect={() => {
                        refresh()
                        close()
                      }}
                    >
                      {t('common.refresh')}
                    </MenuItem>
                  </>
                )}
              </Menu>
            ) : (
              <>
                <Menu
                  label={t('files.new')}
                  trigger={<Plus size={14} />}
                  width={190}
                  disabled={busy}
                  triggerClassName="flex size-6 items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
                >
                  {(close) => <>
                    <MenuItem icon={<FilePlus2 size={14} />} onSelect={() => {
                      beginOperation({ operation: 'create-file', path: rootPath, name: '' })
                      close()
                    }}>{t('files.manage.newFile')}</MenuItem>
                    <MenuItem icon={<FolderPlus size={14} />} onSelect={() => {
                      beginOperation({ operation: 'create-directory', path: rootPath, name: '' })
                      close()
                    }}>{t('files.manage.newDirectory')}</MenuItem>
                  </>}
                </Menu>
                <IconButton
                  label={sortLabel(t, sortBy)}
                  size={24}
                  active={sortBy !== 'name'}
                  onClick={() => cycleSort(setSortBy)}
                >
                  <ArrowUpDown size={14} />
                </IconButton>
                <IconButton
                  label={showHidden ? t('files.hideHidden') : t('files.showHidden')}
                  size={24}
                  active={showHidden}
                  onClick={() => setShowHidden((v) => !v)}
                >
                  {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                </IconButton>
                <IconButton label={t('files.collapseAll')} size={24} onClick={() => setExpanded(new Set())}>
                  <ListCollapse size={14} />
                </IconButton>
                <IconButton label={t('files.manage.reveal')} size={24} onClick={() => void reveal(rootPath)}>
                  <FolderOpen size={14} />
                </IconButton>
                <IconButton label={t('common.refresh')} size={24} onClick={() => refresh()} disabled={loading.size > 0}>
                  <RefreshCw size={14} className={cn(loading.size > 0 && 'animate-spin')} />
                </IconButton>
              </>
            ))}
        </div>
      </div>

      {notice !== null && (
        <div role={notice.error ? 'alert' : 'status'} className={cn(
          'mx-2 mb-1.5 flex items-start gap-1 rounded-[7px] bg-tint px-2 py-1.5 text-[12px]',
          notice.error ? 'text-danger' : 'text-fg-muted',
        )}>
          <span className="min-w-0 flex-1 break-words">{t(notice.key, { path: notice.path ?? '' })}</span>
          <IconButton label={t('files.manage.dismissStatus')} size={18} onClick={() => setNotice(null)}>
            <X size={11} />
          </IconButton>
        </div>
      )}
      {loading.size > 0 && listings[rootPath] !== undefined && (
        <div role="status" className="flex items-center gap-1.5 px-3 py-1 text-[11.5px] text-fg-faint">
          <Loader2 size={12} className="animate-spin" />
          {t('files.manage.refreshing')}
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {scope === 'conversation' ? (
          <EmptyState title={t('files.noConversation')} hint={t('files.noConversationHint')} className="py-10" />
        ) : failed.has(rootPath) ? (
          <div className="flex flex-col items-center py-8">
            <EmptyState title={t('files.unreadable')} hint={t('files.unreadableHint')} className="pb-4" />
            <Button size="sm" onClick={() => load(rootPath)} disabled={loading.has(rootPath)}>
              {t(loading.has(rootPath) ? 'common.loading' : 'common.retry')}
            </Button>
          </div>
        ) : root === undefined ? (
          <EmptyState title={t('common.loading')} className="py-10" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={query !== null && query !== '' ? t('files.noMatch') : t('files.empty')}
            className="py-10"
          />
        ) : (
          <div role="tree" aria-label={t('files.manage.tree')} aria-busy={loading.size > 0}>
            {rows.map(({ entry, depth }) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={depth}
                expanded={expanded.has(entry.path)}
                failed={failed.has(entry.path)}
                loading={loading.has(entry.path)}
                selected={entry.path === selectedPath}
                busy={busy}
                onOperation={(operation) => beginOperation({ operation, path: entry.path, name: entry.name })}
                onDelete={() => {
                  setNotice(null)
                  void submitOperation({ workspaceId: workspace.id, operation: 'delete', path: entry.path })
                }}
                onReveal={() => void reveal(entry.path)}
                onClick={() =>
                  entry.kind === 'dir' ? toggleDir(entry.path) : onOpenFile(entry.path, entry.name)
                }
              />
            ))}
            {root.truncated && (
              <p className="px-2 py-2 text-[11.5px] text-fg-faint">
                {t('files.manage.truncated', { count: root.entries.length })}
              </p>
            )}
          </div>
        )}
      </div>
      {operation !== null && operation.operation !== 'delete' && (
        <FileOperationDialog
          key={`${operation.operation}:${operation.path}`}
          workspaceId={workspace.id}
          target={operation}
          busy={busy}
          hidden={confirmingChanges}
          failure={operationError}
          onSubmit={(request) => void submitOperation(request)}
          onClose={() => !busy && setOperation(null)}
        />
      )}
    </div>
  )
}

function TreeRow({
  entry,
  depth,
  expanded,
  failed,
  loading,
  selected,
  busy,
  onOperation,
  onDelete,
  onReveal,
  onClick
}: {
  entry: FileEntry
  depth: number
  expanded: boolean
  failed: boolean
  loading: boolean
  selected: boolean
  busy: boolean
  onOperation: (operation: FileOperationTarget['operation']) => void
  onDelete: () => void
  onReveal: () => void
  onClick: () => void
}): ReactNode {
  const { t } = useI18n()
  const { Icon, className } = iconFor(entry.name, entry.kind, expanded)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={depth + 1}
      aria-label={failed ? t('files.manage.readFailed') : entry.name}
      aria-busy={loading}
      aria-expanded={entry.kind === 'dir' ? expanded : undefined}
      aria-selected={selected}
      title={entry.path}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      // 缩进走 padding 而不是嵌套 div:树是**平铺**渲染的(见 flatten),
      // 这样虚拟化和键盘上下移动将来都只面对一维数组
      style={{ paddingLeft: 4 + depth * INDENT }}
      className={cn(
        'group flex h-[26px] cursor-default items-center gap-1.5 rounded-[7px] pr-1 text-[12.5px]',
        'transition-colors select-none outline-none focus-visible:ring-1 focus-visible:ring-accent',
        selected ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:bg-tint-hover hover:text-fg'
      )}
    >
      {/* 占位一律画:没有它,文件名会比同级目录名左移 14px,一列名字就对不齐了 */}
      <span className="flex size-3.5 shrink-0 items-center justify-center text-fg-faint">
        {loading ? <Loader2 size={12} className="animate-spin" /> : entry.kind === 'dir' && (
          <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
        )}
      </span>
      <Icon size={14} className={cn('shrink-0', className)} />
      <span className={cn('min-w-0 flex-1 truncate', failed && 'text-danger')}>{entry.name}</span>
      <div onClick={(e) => e.stopPropagation()}>
        <Menu
          label={t('files.manage.actions', { name: entry.name })}
          trigger={<MoreHorizontal size={12} />}
          disabled={busy}
          onOpenChange={(open) => {
            if (!open) setConfirmingDelete(false)
          }}
          align="end"
          width={200}
          triggerClassName={cn(
            'flex size-[18px] shrink-0 items-center justify-center rounded-[5px]',
            'text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
            'hover:bg-tint-strong hover:text-fg focus-visible:opacity-100 aria-expanded:opacity-100',
          )}
        >
          {(close) => {
            const act = (operation: Exclude<FileOperationTarget['operation'], 'delete'>): void => {
              close()
              onOperation(operation)
            }
            return <>
              {entry.kind === 'dir' && <>
                <MenuItem icon={<FilePlus2 size={14} />} onSelect={() => act('create-file')}>
                  {t('files.manage.newFile')}
                </MenuItem>
                <MenuItem icon={<FolderPlus size={14} />} onSelect={() => act('create-directory')}>
                  {t('files.manage.newDirectory')}
                </MenuItem>
                <MenuSeparator />
              </>}
              <MenuItem icon={<Pencil size={14} />} onSelect={() => act('rename')}>
                {t('files.manage.rename')}
              </MenuItem>
              <MenuItem icon={<Copy size={14} />} onSelect={() => act('copy')}>
                {t('files.manage.copy')}
              </MenuItem>
              <MenuItem icon={<MoveRight size={14} />} onSelect={() => act('move')}>
                {t('files.manage.move')}
              </MenuItem>
              <MenuItem icon={<FolderOpen size={14} />} onSelect={() => { close(); onReveal() }}>
                {t('files.manage.reveal')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onSelect={() => {
                  if (confirmingDelete) {
                    setConfirmingDelete(false)
                    close()
                    onDelete()
                  } else {
                    setConfirmingDelete(true)
                  }
                }}
              >
                {confirmingDelete ? t('common.confirmDelete') : t('files.manage.delete')}
              </MenuItem>
            </>
          }}
        </Menu>
      </div>
    </div>
  )
}

function sortLabel(t: ReturnType<typeof useI18n>['t'], sort: SortBy): string {
  return t({ name: 'files.sortName', mtime: 'files.sortMtime', size: 'files.sortSize' }[sort])
}

function cycleSort(set: (f: (cur: SortBy) => SortBy) => void): void {
  set((cur) => (cur === 'name' ? 'mtime' : cur === 'mtime' ? 'size' : 'name'))
}

/**
 * 工具条是否该折起来。用 `ResizeObserver` 而不是窗口宽度:
 * **右侧面板自己是可拖宽的**,窗口没变而面板变了才是常态。
 */
function useToolbarCompact(ref: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const ro = new ResizeObserver(([e]) => {
      if (e !== undefined) setCompact(e.contentRect.width < TOOLBAR_FULL_WIDTH)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return compact
}

/**
 * 接到 Tab 系统上的那一层。`FilesView` 自己不碰 store —— 它只认
 * 「根在哪 / 选中哪个 / 打开时叫谁」,这样它在测试里是纯的。
 */
export function FilesTab({ tab, workspace }: { tab: InnerTab; workspace: Workspace }): ReactNode {
  const openPath = useTabsStore((s) => s.openPath)

  /*
    选中行 = **主区**正在看的那个文件。选择器只回一个字符串,
    不回对象 —— 回对象的话每次 render 都是新引用,zustand 会认为状态变了。
  */
  const selectedPath = useTabsStore((s) => {
    const st = s.stateOf(workspace.id)
    const active = st.tabs.find((t) => t.id === st.activeTabId)
    return active !== undefined && 'path' in active.ref ? active.ref.path : null
  })

  return (
    <FilesView
      workspace={workspace}
      rootPath={tab.kind === 'files' ? tab.ref.path : ''}
      selectedPath={selectedPath}
      onOpenFile={(path, name) => openPath(workspace.id, 'doc', path, name)}
    />
  )
}
