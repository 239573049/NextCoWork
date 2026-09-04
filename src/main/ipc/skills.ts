/**
 * Skill 的 handler —— 「磁盘上那些目录」和「界面上那份清单」之间的接线员。
 *
 * 分工和 `ipc/mcp.ts` 一样:扫描与校验在内核(`kernel/skill/load.ts`,
 * 那一侧完全不认识 electron),开关状态在 `store`,这里只做三件事 ——
 * 触发扫描、把两份状态合成一份下发、写完之后广播。
 *
 * ## 两个开关是两件不同的事
 *
 * - `globalEnabled`:用户在设置页整个关掉了这条 Skill。存在 kv 里,
 *   而且存的是**被关掉的那些**(理由在 `store.getDisabledSkillIds`)。
 * - `activeInWorkspace`:这个工作区选装了哪几条。存在
 *   `WorkspaceSettings.activeSkillIds` 里,**空清单 = 全都要**
 *   (理由在 `SkillRegistry.resolve`)。
 *
 * 合起来才是「这一轮下发哪几条」,而那个合并只在 `runtime.ts` 的
 * `activeSkills()` 里做一次 —— 这里只负责把两份状态如实显示给用户。
 */
import type { SkillListItem } from '../../shared/domain/skill'
import { refreshSkills } from '../runtime'
import { skillRegistry } from '../kernel/skill/registry'
import { store } from '../state/store'
import { windows } from '../window/registry'

function broadcast(): void {
  windows.emitToAll('skills:changed', undefined)
}

/**
 * 列出当前装了哪些。
 *
 * ★ **每次都重扫**,不返回上一次的缓存。用户刚往 `skills/` 里拖了一个目录
 * 就来看这个列表,而「关掉设置页再打开」并不会重扫 —— 那样他会以为装失败了。
 * 扫描是两次 readDir,开一次设置页的成本可以忽略。
 */
export async function listSkills(req: { workspaceId?: string }): Promise<SkillListItem[]> {
  await refreshSkills(req.workspaceId ?? '')

  const disabled = new Set(store.getDisabledSkillIds())
  const active = activeIdsOf(req.workspaceId)

  return skillRegistry()
    .list()
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      sourceKind: s.source.kind,
      ...(s.scope !== undefined ? { scope: s.scope } : {}),
      globalEnabled: !disabled.has(s.id),
      // 空清单 = 全都要,所以此时每一条显示的都是「已启用」
      activeInWorkspace: active === null || active.length === 0 || active.includes(s.id)
    }))
}

export function setSkillGlobalEnabled(req: { skillId: string; enabled: boolean }): void {
  store.setSkillGlobalEnabled(req.skillId, req.enabled)
  broadcast()
}

/**
 * 在某个工作区里选装 / 取消选装一条。
 *
 * ★ 这里有一处**必须显式处理**的不对称,来自「空清单 = 全都要」这个语义:
 *
 * 空清单时把某一条关掉,不能只是「从空清单里删掉它」(那是个空操作,
 * 用户点了开关却什么都没发生)。得先把**当前所有 Skill 的 id 铺开**,
 * 再从里面去掉这一条 —— 也就是把隐式的「全都要」物化成一份显式清单。
 *
 * 代价是这之后新装的 Skill 在这个工作区默认不生效了。这是对的:用户
 * 一旦手动选装过,「我选的就是我要的」比「悄悄给你加一条」更符合预期。
 */
export function setSkillWorkspaceActive(req: {
  skillId: string
  workspaceId: string
  active: boolean
}): void {
  const ws = store.getWorkspace(req.workspaceId)
  if (ws === undefined) throw new Error(`没有 id 为 "${req.workspaceId}" 的工作区。`)

  const current = ws.settings.activeSkillIds
  const all = skillRegistry()
    .list()
    .map((s) => s.id)
  // 隐式的「全都要」在这里物化,否则关掉一条会是个空操作
  const base = current.length === 0 ? all : current

  const next = req.active
    ? [...new Set([...base, req.skillId])]
    : base.filter((id) => id !== req.skillId)

  store.putWorkspace({ ...ws, settings: { ...ws.settings, activeSkillIds: next } })
  broadcast()
}

/** `null` = 没指定工作区(全局设置页),此时不谈「在这个工作区激活」。 */
function activeIdsOf(workspaceId: string | undefined): string[] | null {
  if (workspaceId === undefined) return null
  return store.getWorkspace(workspaceId)?.settings.activeSkillIds ?? null
}
