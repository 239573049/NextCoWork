/**
 * 「选择导入」弹窗的判断逻辑。**这里没有一行 DOM。**
 *
 * 理由和 `model/import-models.ts` 文件头写的一样:vitest 是 node 环境、只收
 * `.test.ts`,留在 `.tsx` 里的规则一行都不会被测到。而这个弹窗里真正容易错的
 * 恰恰全是规则:三分组的半选态、项目范围联动、「没有有效选择就禁用提交」。
 */
import type {
  ImportCategory,
  ImportPreviewItem,
  ImportProjectCandidate
} from '../../../../../shared/domain/import'

/** 三个可折叠分组。★ 顺序即界面顺序。 */
export type ImportGroupId = 'tools' | 'providers' | 'projects' | 'chats' | 'skills' | 'hooks'

export const IMPORT_GROUPS: ReadonlyArray<{ id: ImportGroupId; categories: readonly ImportCategory[] }> = [
  { id: 'providers', categories: ['provider'] },
  { id: 'projects', categories: ['project'] },
  { id: 'chats', categories: ['chat'] },
  { id: 'skills', categories: ['skill'] },
  { id: 'hooks', categories: ['hook'] },
  { id: 'tools', categories: ['mcp', 'instructions', 'agent', 'command'] }
]

export function groupOf(category: ImportCategory): ImportGroupId {
  return IMPORT_GROUPS.find((g) => g.categories.includes(category))?.id ?? 'tools'
}

export type TriState = 'none' | 'some' | 'all'

/**
 * 这一轮提交结束后**会有工作区**的那些项目 key。
 *
 * ★★ 这个函数是隔离 Electron 探针抓出来的一个真 bug 的答案。
 *
 * 全新安装上,源里每个项目都还没有对应的本地工作区,于是它下面的每一条聊天在
 * 预览里都是 `needs-target`。而 `needs-target` 不可勾 —— 结果是**用户没有任何
 * 办法把聊天选进来**:勾上项目也没用,因为聊天的可勾性是在服务端快照里定死的。
 * 症状极具迷惑性:导入「成功」了,计数是 3,而会话列表空空如也。
 *
 * 三种情况都算「会有工作区」:
 * 1. 项目候选上已经带了 `targetWorkspaceId`(本地早就有同路径的工作区);
 * 2. 用户在这个弹窗里现指了一个;
 * 3. **这个项目本身也被勾上了** —— 提交时项目排在聊天之前(`order()`),
 *    它会先把工作区建出来。
 */
export function resolvedProjectKeys(
  items: readonly ImportPreviewItem[],
  selected: ReadonlySet<string>,
  projects: readonly ImportProjectCandidate[],
  targets: ReadonlyMap<string, string>
): Set<string> {
  const resolved = new Set<string>()
  for (const project of projects) {
    if (project.targetWorkspaceId !== undefined) resolved.add(project.key)
  }
  for (const key of targets.keys()) resolved.add(key)
  for (const item of items) {
    if (item.category !== 'project') continue
    if (item.projectKey === undefined) continue
    if (item.targetWorkspaceId !== undefined) resolved.add(item.projectKey)
    // 勾上的项目会在聊天之前落地,所以它算数
    if (selected.has(item.id)) resolved.add(item.projectKey)
  }
  return resolved
}

/**
 * 一组的勾选态。
 *
 * ★ **分母只算「可选的」** —— 不兼容项和「已存在」项永远勾不上,把它们算进
 * 分母的话,全选之后组标题上那个框仍然是半选,用户会一直找那个没勾上的是谁。
 */
export function groupState(
  items: readonly ImportPreviewItem[],
  selected: ReadonlySet<string>,
  resolved: ReadonlySet<string> = new Set()
): TriState {
  const selectable = items.filter((item) => isSelectable(item, resolved))
  if (selectable.length === 0) return 'none'
  const hit = selectable.filter((item) => selected.has(item.id)).length
  if (hit === 0) return 'none'
  return hit === selectable.length ? 'all' : 'some'
}

/**
 * 这一项能不能被勾。
 *
 * ★ `needs-target` **只在它所属项目这一轮会有工作区时**可勾(见
 * `resolvedProjectKeys`)。无条件放开的话,勾上去只会换来一条 skipped;
 * 无条件禁止的话,全新安装上聊天永远导不进来。
 */
export function isSelectable(
  item: ImportPreviewItem,
  resolved: ReadonlySet<string> = new Set()
): boolean {
  if (item.status === 'new' || item.status === 'update') return true
  // A missing source directory is still a valid workspace root to register.
  // Selecting the project lets the main process create that workspace before chats.
  if (item.category === 'project' && item.status === 'needs-target') return true
  if (item.status !== 'needs-target') return false
  return item.projectKey !== undefined && resolved.has(item.projectKey)
}

/** 组级全选 / 全不选。半选态点一下 = 全选(更常见的意图是「都要」)。 */
export function toggleGroup(
  items: readonly ImportPreviewItem[],
  selected: ReadonlySet<string>,
  resolved: ReadonlySet<string> = new Set()
): Set<string> {
  const next = new Set(selected)
  const selectable = items.filter((item) => isSelectable(item, resolved))
  const state = groupState(items, selected, resolved)
  for (const item of selectable) {
    if (state === 'all') next.delete(item.id)
    else next.add(item.id)
  }
  return next
}

export function toggleItem(
  item: ImportPreviewItem,
  selected: ReadonlySet<string>,
  resolved: ReadonlySet<string> = new Set()
): Set<string> {
  const next = new Set(selected)
  if (!isSelectable(item, resolved)) return next
  if (next.has(item.id)) next.delete(item.id)
  else next.add(item.id)
  return next
}

/**
 * 默认勾选集。主进程已经在每一项上算好了 `defaultSelected` ——
 * 这里**不重算**一遍判据,只照着用。两处各写一份的话,预览里那个「新增 12 项」
 * 的计数和实际勾上的条数会对不上,而没有任何机制会报警。
 *
 * ★ 两轮:第一轮先定下项目(它们的 `defaultSelected` 与聊天无关),
 * 第二轮再用「项目已入选」这个事实把它们下面的聊天一并勾上。全新安装上,
 * 用户打开弹窗看到的就该是「项目 + 它的聊天都已勾好」,而不是一堆灰掉的聊天。
 */
export function initialSelection(
  items: readonly ImportPreviewItem[],
  projects: readonly ImportProjectCandidate[] = []
): Set<string> {
  const first = new Set(
    items.filter((item) => item.defaultSelected && isSelectable(item)).map((item) => item.id)
  )
  const resolved = resolvedProjectKeys(items, first, projects, new Map())
  for (const item of items) {
    if (first.has(item.id)) continue
    if (!item.defaultSelected && item.status !== 'needs-target') continue
    if (isSelectable(item, resolved)) first.add(item.id)
  }
  return first
}

/**
 * 提交前的有效性。
 *
 * ★ 两条独立的门,缺一不可:
 * 1. 至少选了一项;
 * 2. **被选中的聊天,它所属项目必须已经有目标工作区**。否则那些聊天会全部
 *    变成 skipped,而用户以为自己导进来了 —— 这正是「聊天必须有目标工作区映射」
 *    这条要在按钮上体现出来的地方。
 */
export function submitBlockers(
  items: readonly ImportPreviewItem[],
  selected: ReadonlySet<string>,
  projects: readonly ImportProjectCandidate[],
  targets: ReadonlyMap<string, string>
): { ok: boolean; missingProjects: string[] } {
  const chosen = items.filter((item) => selected.has(item.id))
  if (chosen.length === 0) return { ok: false, missingProjects: [] }

  const resolved = resolvedProjectKeys(items, selected, projects, targets)
  const missing = new Set<string>()
  for (const item of chosen) {
    if (item.category !== 'chat') continue
    const key = item.projectKey
    if (key === undefined) {
      missing.add('')
      continue
    }
    if (!resolved.has(key)) missing.add(key)
  }
  return { ok: missing.size === 0, missingProjects: [...missing] }
}

/** 选中项按类别计数 —— 提交按钮上那个数字。 */
export function selectedCounts(
  items: readonly ImportPreviewItem[],
  selected: ReadonlySet<string>
): { total: number; byCategory: Partial<Record<ImportCategory, number>> } {
  const byCategory: Partial<Record<ImportCategory, number>> = {}
  let total = 0
  for (const item of items) {
    if (!selected.has(item.id)) continue
    total += 1
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
  }
  return { total, byCategory }
}
