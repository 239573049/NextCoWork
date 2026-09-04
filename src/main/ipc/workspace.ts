/**
 * 工作区 handler。
 *
 * ★ 选目录走主进程 dialog.showOpenDialog —— **渲染层永不指定任意路径**(方案 §9)。
 * 这条不是洁癖:一旦渲染层能传路径进来,它就能传 `/`,而工作区根是
 * resolveInWorkspace 的信任基点,根被污染整条路径围栏就失效了。
 */
import { dialog } from 'electron'
import { basename } from 'node:path'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import type { DirListing, FileEntry } from '../../shared/domain/file-tree'
import { DIR_LISTING_LIMIT, sortEntries } from '../../shared/domain/file-tree'
import type { Workspace, WorkspaceSettings } from '../../shared/domain/workspace'
import { DEFAULT_WORKSPACE_SETTINGS } from '../../shared/domain/workspace'
import { prefixedId } from '../../shared/util/id'
import { resolveInWorkspace } from '../kernel/tool/path-guard'
import { store } from '../state/store'
import { windows } from '../window/registry'
import { IpcError } from './errors'

function announce(): void {
  windows.emitToAll('workspace:changed', { workspaces: store.listWorkspaces() })
}

export function listWorkspaces(): Workspace[] {
  return store.listWorkspaces()
}

export async function pickWorkspace(): Promise<Workspace | null> {
  const r = await dialog.showOpenDialog({
    title: '选择工作区目录',
    properties: ['openDirectory', 'createDirectory']
  })
  const picked = r.canceled ? undefined : r.filePaths[0]
  if (!picked) return null

  // ★ 立刻 realpath:macOS 上 /var → /private/var,不在这里归一化,
  //   路径围栏后面就要面对两个都"正确"的根(方案 §9)
  const rootPath = realpathSync.native(picked)

  const existing = store.listWorkspaces().find((w) => w.rootPath === rootPath)
  if (existing) {
    const touched = store.putWorkspace({ ...existing, lastOpenedAt: Date.now(), unavailable: false })
    announce()
    return touched
  }

  const now = Date.now()
  const ws = store.putWorkspace({
    id: prefixedId('ws'),
    name: basename(rootPath) || rootPath,
    rootPath,
    settings: structuredClone(DEFAULT_WORKSPACE_SETTINGS),
    createdAt: now,
    lastOpenedAt: now
  })
  announce()
  return ws
}

export function updateWorkspace(req: {
  id: string
  name?: string
  settings?: Partial<WorkspaceSettings>
}): Workspace {
  const cur = store.getWorkspace(req.id)
  if (!cur) throw new IpcError('unknown', `工作区不存在: ${req.id}`)
  const next = store.putWorkspace({
    ...cur,
    name: req.name ?? cur.name,
    settings: req.settings ? { ...cur.settings, ...req.settings } : cur.settings
  })
  announce()
  return next
}

/**
 * 关闭 = 从**记录**里移除,和「关闭外层 Tab」是两回事(方案 §8 三个必须分清的概念)。
 * 外层 Tab 的开关纯粹是窗口状态,不经过这里。
 */
export function closeWorkspace(id: string): void {
  store.removeWorkspace(id)
  announce()
}

/**
 * 右侧文件树列**一层**。
 *
 * 三件事值得写下来:
 *
 * 1. **`req.path` 是不可信输入**。它来自渲染层,所以一律经 `resolveInWorkspace`
 *    (方案 §9 的唯一入口)。`../../etc` 在那里被拒,不在这里。
 * 2. **不递归**。参考实现的目录默认是收起的(`>`),展开一个才拉一层 ——
 *    这不只是交互,它是让 `node_modules` 不会一次性把 IPC 撑爆的原因。
 * 3. **`withFileTypes` + 逐项 `statSync` 分开**。`stat` 会跟随符号链接,
 *    指向不存在目标的软链会抛 —— 那一项按"文件、无大小"处理,不能让整次列目录失败。
 */
export function listDir(req: { workspaceId: string; path: string }): DirListing {
  const ws = store.getWorkspace(req.workspaceId)
  if (!ws) throw new IpcError('unknown', `工作区不存在: ${req.workspaceId}`)

  const dir = resolveInWorkspace(ws.rootPath, req.path)

  const raw = readdirSync(dir, { withFileTypes: true })
  const truncated = raw.length > DIR_LISTING_LIMIT
  const entries: FileEntry[] = []

  for (const d of raw.slice(0, DIR_LISTING_LIMIT)) {
    // 软链要看它指向什么:指向目录的软链在树里就该是个能展开的目录
    let isDir = d.isDirectory()
    let size: number | undefined
    let mtime: number | undefined
    try {
      const st = statSync(`${dir}/${d.name}`)
      isDir = st.isDirectory()
      if (!isDir) size = st.size
      mtime = st.mtimeMs
    } catch {
      // 断掉的软链 / 刚被删掉 / 没权限 —— 仍然列出来,只是没有大小
    }
    entries.push({
      name: d.name,
      path: req.path === '' ? d.name : `${req.path}/${d.name}`,
      kind: isDir ? 'dir' : 'file',
      hidden: d.name.startsWith('.'),
      ...(size !== undefined ? { size } : {}),
      ...(mtime !== undefined ? { mtime } : {})
    })
  }

  return { path: req.path, entries: sortEntries(entries), truncated }
}
