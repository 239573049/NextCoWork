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
  Eye,
  EyeOff,
  FolderOpen,
  ListCollapse,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DirListing, FileEntry, SortBy } from '../../../../shared/domain/file-tree'
import type { InnerTab } from '../../../../shared/domain/tab'
import type { Workspace } from '../../../../shared/domain/workspace'
import { EmptyState } from '../../components/ui/EmptyState'
import { IconButton } from '../../components/ui/IconButton'
import { Menu, MenuItem, MenuSeparator } from '../../components/ui/Menu'
import { cn } from '../../lib/cn'
import { iconFor } from '../../lib/file-icon'
import { listDir } from '../../services/app'
import { useTabsStore } from '../../stores/tabs'
import { flatten } from './flatten'

type Scope = 'conversation' | 'all'

const SCOPES: readonly { id: Scope; label: string }[] = [
  { id: 'conversation', label: '对话文件' },
  { id: 'all', label: '所有文件' }
]

/**
 * 工具条全展开需要的宽度。低于它就折进 `…`。
 *
 * 量参考截图定的:窄面板(面板宽 ≈297,工具条可用宽 ≈270)只放得下「搜索 + `…`」,
 * 宽面板(≈608)七颗全在。400 落在两者中间,且留出了 scope 那两个 chip 的位置。
 */
const TOOLBAR_FULL_WIDTH = 400

/** 一层缩进。12 是让第 3 层还看得出层级、又不至于把长文件名挤没的那个值。 */
const INDENT = 12

export function FilesView({
  workspace,
  rootPath,
  selectedPath,
  onOpenFile
}: {
  workspace: Workspace
  /** 子树根,工作区相对;`''` = 工作区根(见 InnerTab 的 files.ref.path) */
  rootPath: string
  /** 当前在主区打开的那个文件,用来画选中行 */
  selectedPath: string | null
  onOpenFile: (path: string, name: string) => void
}): ReactNode {
  const [scope, setScope] = useState<Scope>('all')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [showHidden, setShowHidden] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [listings, setListings] = useState<Readonly<Record<string, DirListing>>>({})
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())

  const toolbar = useRef<HTMLDivElement>(null)
  const compact = useToolbarCompact(toolbar)

  const load = useCallback(
    (path: string): void => {
      void listDir(workspace.id, path)
        .then((l) => {
          setListings((prev) => ({ ...prev, [path]: l }))
          setFailed((prev) => {
            if (!prev.has(path)) return prev
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        })
        .catch((err: unknown) => {
          // 目录读不到(权限 / 刚被删)只该让**那一行**显示读取失败,
          // 不该把整棵树打空 —— 树是一层一层来的,一层坏不等于整棵坏。
          console.error('[files] 列目录失败:', path, err)
          setFailed((prev) => new Set(prev).add(path))
        })
    },
    [workspace.id]
  )

  // 换工作区 / 换子树根:整棵重来。旧工作区的路径在新根下毫无意义,
  // 留着会让第一帧画出上一个项目的文件名。
  useEffect(() => {
    setListings({})
    setFailed(new Set())
    setExpanded(new Set())
    load(rootPath)
  }, [load, rootPath])

  const toggleDir = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (listings[path] === undefined) load(path)
      }
      return next
    })
  }

  const refresh = (): void => {
    setListings({})
    setFailed(new Set())
    load(rootPath)
    // 展开状态**留着**:刷新是"重新读盘",不是"把我打开的目录都收起来"
    for (const p of expanded) load(p)
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
          {SCOPES.map((s) => (
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
            <IconButton label="搜索文件" size={24} onClick={() => setQuery('')}>
              <Search size={14} />
            </IconButton>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1 rounded-[7px] bg-surface-input px-1.5">
              <Search size={12} className="shrink-0 text-fg-faint" />
              <input
                autoFocus
                value={query}
                placeholder="按名称过滤"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery(null)}
                className="min-w-0 flex-1 bg-transparent py-1 text-[12.5px] text-fg outline-none placeholder:text-fg-faint"
              />
              <IconButton label="关闭搜索" size={18} onClick={() => setQuery(null)}>
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
                label="更多操作"
                width={190}
                trigger={<MoreHorizontal size={14} />}
                triggerClassName="flex size-6 items-center justify-center rounded-[8px] text-icon transition-colors hover:bg-tint-hover hover:text-fg"
              >
                {(close) => (
                  <>
                    <MenuItem icon={<Plus size={14} />} onSelect={close}>
                      新建文件
                    </MenuItem>
                    <MenuItem
                      icon={<ArrowUpDown size={14} />}
                      onSelect={() => {
                        cycleSort(setSortBy)
                        close()
                      }}
                    >
                      {SORT_LABEL[sortBy]}
                    </MenuItem>
                    <MenuItem
                      icon={showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      onSelect={() => {
                        setShowHidden((v) => !v)
                        close()
                      }}
                    >
                      {showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      icon={<ListCollapse size={14} />}
                      onSelect={() => {
                        setExpanded(new Set())
                        close()
                      }}
                    >
                      全部折叠
                    </MenuItem>
                    <MenuItem icon={<FolderOpen size={14} />} onSelect={close}>
                      在访达中显示
                    </MenuItem>
                    <MenuItem
                      icon={<RefreshCw size={14} />}
                      onSelect={() => {
                        refresh()
                        close()
                      }}
                    >
                      刷新
                    </MenuItem>
                  </>
                )}
              </Menu>
            ) : (
              <>
                <IconButton label="新建文件" size={24}>
                  <Plus size={14} />
                </IconButton>
                <IconButton
                  label={SORT_LABEL[sortBy]}
                  size={24}
                  active={sortBy !== 'name'}
                  onClick={() => cycleSort(setSortBy)}
                >
                  <ArrowUpDown size={14} />
                </IconButton>
                <IconButton
                  label={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
                  size={24}
                  active={showHidden}
                  onClick={() => setShowHidden((v) => !v)}
                >
                  {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                </IconButton>
                <IconButton label="全部折叠" size={24} onClick={() => setExpanded(new Set())}>
                  <ListCollapse size={14} />
                </IconButton>
                <IconButton label="在访达中显示" size={24}>
                  <FolderOpen size={14} />
                </IconButton>
                <IconButton label="刷新" size={24} onClick={refresh}>
                  <RefreshCw size={14} />
                </IconButton>
              </>
            ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {scope === 'conversation' ? (
          <EmptyState title="这次对话还没有碰过文件" hint="Agent 读写过的文件会出现在这里" className="py-10" />
        ) : failed.has(rootPath) ? (
          <EmptyState title="读不到这个目录" hint="可能已被移动或没有访问权限" className="py-10" />
        ) : root === undefined ? (
          <EmptyState title="正在读取…" className="py-10" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={query !== null && query !== '' ? '没有匹配的文件' : '这个目录是空的'}
            className="py-10"
          />
        ) : (
          <>
            {rows.map(({ entry, depth }) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={depth}
                expanded={expanded.has(entry.path)}
                failed={failed.has(entry.path)}
                selected={entry.path === selectedPath}
                onClick={() =>
                  entry.kind === 'dir' ? toggleDir(entry.path) : onOpenFile(entry.path, entry.name)
                }
              />
            ))}
            {root.truncated && (
              <p className="px-2 py-2 text-[11.5px] text-fg-faint">
                目录太大,只列出了前 {root.entries.length} 项
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TreeRow({
  entry,
  depth,
  expanded,
  failed,
  selected,
  onClick
}: {
  entry: FileEntry
  depth: number
  expanded: boolean
  failed: boolean
  selected: boolean
  onClick: () => void
}): ReactNode {
  const { Icon, className } = iconFor(entry.name, entry.kind, expanded)

  return (
    <div
      role="treeitem"
      aria-expanded={entry.kind === 'dir' ? expanded : undefined}
      aria-selected={selected}
      title={entry.path}
      onClick={onClick}
      // 缩进走 padding 而不是嵌套 div:树是**平铺**渲染的(见 flatten),
      // 这样虚拟化和键盘上下移动将来都只面对一维数组
      style={{ paddingLeft: 4 + depth * INDENT }}
      className={cn(
        'group flex h-[26px] cursor-default items-center gap-1.5 rounded-[7px] pr-1 text-[12.5px]',
        'transition-colors select-none',
        selected ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:bg-tint-hover hover:text-fg'
      )}
    >
      {/* 占位一律画:没有它,文件名会比同级目录名左移 14px,一列名字就对不齐了 */}
      <span className="flex size-3.5 shrink-0 items-center justify-center text-fg-faint">
        {entry.kind === 'dir' && (
          <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
        )}
      </span>
      <Icon size={14} className={cn('shrink-0', className)} />
      <span className={cn('min-w-0 flex-1 truncate', failed && 'text-danger')}>{entry.name}</span>
      <button
        type="button"
        aria-label={`${entry.name} 的操作`}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded-[5px]',
          'text-fg-faint opacity-0 transition-opacity group-hover:opacity-100',
          'hover:bg-tint-strong hover:text-fg focus-visible:opacity-100'
        )}
      >
        <MoreHorizontal size={12} />
      </button>
    </div>
  )
}

const SORT_LABEL: Record<SortBy, string> = {
  name: '按名称排序',
  mtime: '按修改时间排序',
  size: '按大小排序'
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
